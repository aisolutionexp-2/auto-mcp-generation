import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Endpoint {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'body';
    type: string;
    required?: boolean;
    default?: any;
    description?: string;
  }>;
  requestBody?: {
    schema: any;
    example?: any;
  };
  responses?: {
    [statusCode: string]: {
      schema: any;
      example?: any;
    };
  };
  tags?: string[];
}

interface ApiSpec {
  baseUrl: string;
  title: string;
  version: string;
  description?: string;
  auth?: {
    type: 'bearer' | 'apikey' | 'oauth';
    header?: string;
    prefix?: string;
    location?: 'header' | 'query';
  };
  rateLimit?: {
    requests_per_minute?: number;
  };
  endpoints: Endpoint[];
  sourceUrls: string[];
}

// Utility functions
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    
    // Block localhost and private IPs
    if (hostname === 'localhost' || 
        hostname.startsWith('127.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('169.254.')) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 20000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'MCP-Generator/1.0 (API Documentation Crawler)',
        ...options.headers,
      },
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Main crawler function
async function crawlApiDocumentation(url: string, options: any = {}): Promise<{ endpoints: Endpoint[], sourceUrls: string[], logs: string[] }> {
  const logs: string[] = [];
  const visitedUrls = new Set<string>();
  const sourceUrls: string[] = [];
  let allEndpoints: Endpoint[] = [];

  logs.push(`[Crawler] Starting crawl of: ${url}`);

  if (!isValidUrl(url) || !isSafeUrl(url)) {
    logs.push(`[Crawler] Invalid or unsafe URL: ${url}`);
    return { endpoints: [], sourceUrls: [], logs };
  }

  // Try to fetch the main page
  try {
    const response = await fetchWithTimeout(url);
    const content = await response.text();
    visitedUrls.add(url);
    sourceUrls.push(url);
    
    logs.push(`[Crawler] Fetched main page: ${response.status}, Content length: ${content.length}`);

    // Detect if this is a Swagger UI page
    const isSwaggerUI = content.includes('swagger-ui') || content.includes('SwaggerUIBundle') || 
                       content.includes('swagger.json') || content.includes('openapi.json');
    
    if (isSwaggerUI) {
      logs.push(`[Crawler] Detected Swagger UI page`);
      const swaggerSpecs = extractSwaggerUIConfig(content, url);
      logs.push(`[Crawler] Found ${swaggerSpecs.length} Swagger specs from UI config`);
      
      for (const specUrl of swaggerSpecs) {
        if (!visitedUrls.has(specUrl)) {
          try {
            const specResponse = await fetchWithTimeout(specUrl);
            const specContent = await specResponse.text();
            visitedUrls.add(specUrl);
            sourceUrls.push(specUrl);
            
            logs.push(`[Crawler] Processing Swagger spec: ${specUrl}`);
            const endpoints = await parseApiSpec(specUrl, specContent, logs);
            allEndpoints = allEndpoints.concat(endpoints);
            logs.push(`[Crawler] Extracted ${endpoints.length} endpoints from Swagger spec`);
          } catch (error) {
            logs.push(`[Crawler] Failed to process Swagger spec ${specUrl}: ${error.message}`);
          }
        }
      }
    }

    // Look for API spec files using improved detection
    const specUrls = await findApiSpecs(url, content);
    logs.push(`[Crawler] Found ${specUrls.length} potential spec URLs`);

    // Process each spec URL
    for (const specUrl of specUrls) {
      if (visitedUrls.has(specUrl)) continue;
      
      // Filter out obvious non-spec URLs
      if (isNonSpecUrl(specUrl)) {
        logs.push(`[Crawler] Skipping non-spec URL: ${specUrl}`);
        continue;
      }
      
      try {
        const specResponse = await fetchWithTimeout(specUrl);
        const specContent = await specResponse.text();
        visitedUrls.add(specUrl);
        sourceUrls.push(specUrl);
        
        logs.push(`[Crawler] Processing spec: ${specUrl}, Content type: ${specResponse.headers.get('content-type')}`);
        
        const endpoints = await parseApiSpec(specUrl, specContent, logs);
        allEndpoints = allEndpoints.concat(endpoints);
        
        logs.push(`[Crawler] Extracted ${endpoints.length} endpoints from ${specUrl}`);
      } catch (error) {
        logs.push(`[Crawler] Failed to process ${specUrl}: ${error.message}`);
      }
    }

    // Enhanced HTML parsing as fallback
    if (allEndpoints.length === 0) {
      logs.push(`[Crawler] No API specs found, trying enhanced HTML parsing`);
      const htmlEndpoints = parseHtmlForEndpoints(content, url);
      allEndpoints = allEndpoints.concat(htmlEndpoints);
      logs.push(`[Crawler] Extracted ${htmlEndpoints.length} endpoints from HTML`);
      
      // Try common API paths as last resort
      if (allEndpoints.length === 0) {
        logs.push(`[Crawler] Trying common API endpoints as last resort`);
        const commonEndpoints = await tryCommonApiPaths(url, logs);
        allEndpoints = allEndpoints.concat(commonEndpoints);
      }
    }

  } catch (error) {
    logs.push(`[Crawler] Error fetching main page: ${error.message}`);
    // Don't throw error, return empty result with logs
    return { endpoints: [], sourceUrls, logs };
  }

  logs.push(`[Crawler] Total endpoints found: ${allEndpoints.length}`);
  return {
    endpoints: allEndpoints,
    sourceUrls,
    logs
  };
}

// Extract Swagger UI config from JavaScript
function extractSwaggerUIConfig(content: string, baseUrl: string): string[] {
  const specs: string[] = [];
  const base = new URL(baseUrl);
  
  // Look for Swagger UI configuration
  const swaggerConfigPatterns = [
    /url:\s*["']([^"']+)["']/gi,
    /spec:\s*["']([^"']+)["']/gi,
    /SwaggerUIBundle\(\s*{\s*url:\s*["']([^"']+)["']/gi,
    /"spec":\s*"([^"]+)"/gi,
    /'spec':\s*'([^']+)'/gi
  ];
  
  for (const pattern of swaggerConfigPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const specUrl = new URL(match[1], base).href;
        if (!specs.includes(specUrl)) {
          specs.push(specUrl);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }
  
  return specs;
}

// Check if URL is likely not a spec file
function isNonSpecUrl(url: string): boolean {
  const nonSpecExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf'];
  const lowerUrl = url.toLowerCase();
  
  return nonSpecExtensions.some(ext => lowerUrl.endsWith(ext)) ||
         lowerUrl.includes('static/') ||
         lowerUrl.includes('assets/') ||
         lowerUrl.includes('images/') ||
         lowerUrl.includes('.min.');
}

// Try common API endpoints
async function tryCommonApiPaths(baseUrl: string, logs: string[]): Promise<Endpoint[]> {
  const endpoints: Endpoint[] = [];
  const base = new URL(baseUrl);
  
  const commonApiPaths = [
    '/api',
    '/api/v1',
    '/api/v2', 
    '/v1',
    '/v2'
  ];
  
  for (const path of commonApiPaths) {
    try {
      const apiUrl = new URL(path, base).href;
      const response = await fetchWithTimeout(apiUrl, { method: 'HEAD' }, 5000);
      
      if (response.ok) {
        logs.push(`[Crawler] Found working API endpoint: ${apiUrl}`);
        endpoints.push({
          path: path,
          method: 'GET',
          summary: `API endpoint at ${path}`,
          description: `Discovered API endpoint`
        });
      }
    } catch (error) {
      // Ignore errors for common path testing
    }
  }
  
  return endpoints;
}

async function findApiSpecs(baseUrl: string, content: string): Promise<string[]> {
  const specs: string[] = [];
  const base = new URL(baseUrl);

  // Enhanced API spec patterns
  const patterns = [
    /href=["']([^"']*(?:openapi|swagger|api-docs|docs)[^"']*)["']/gi,
    /src=["']([^"']*(?:openapi|swagger|api-docs)[^"']*)["']/gi,
    /"([^"]*\/(?:openapi|swagger|api-docs|docs)(?:\.json|\.yaml|\.yml)?[^"]*)"/gi,
    /data-swagger-ui[^>]*url=["']([^"']+)["']/gi,
    /window\.ui\s*=\s*SwaggerUIBundle\(\s*{\s*url:\s*["']([^"']+)["']/gi
  ];

  // Extended common spec endpoints
  const commonPaths = [
    '/openapi.json',
    '/swagger.json', 
    '/api-docs',
    '/api/docs',
    '/docs/api',
    '/swagger/v1/swagger.json',
    '/v1/swagger.json',
    '/api/v1/swagger.json',
    '/swagger.yaml',
    '/openapi.yaml',
    '/api-docs.json',
    '/swagger/docs/v1',
    '/docs/swagger.json'
  ];

  // Extract from content
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const url = new URL(match[1], base).href;
        if (!specs.includes(url) && !isNonSpecUrl(url)) {
          specs.push(url);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }

  // Try common paths
  for (const path of commonPaths) {
    try {
      const url = new URL(path, base).href;
      if (!specs.includes(url)) {
        specs.push(url);
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  return specs;
}

async function parseApiSpec(url: string, content: string, logs: string[]): Promise<Endpoint[]> {
  try {
    // Try to parse as JSON first
    const spec = JSON.parse(content);
    
    if (spec.openapi || spec.swagger) {
      return parseOpenApiSpec(spec, url);
    }
    
    if (spec.info && spec.paths) {
      return parseOpenApiSpec(spec, url);
    }
    
    if (spec.collection) {
      return parsePostmanCollection(spec);
    }
    
  } catch (error) {
    // If JSON parsing fails, try YAML (basic support)
    logs.push(`[Parser] JSON parsing failed, content might be YAML: ${error.message}`);
  }

  return [];
}

function parseOpenApiSpec(spec: any, baseUrl: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const basePath = spec.basePath || '';
  
  if (!spec.paths) return endpoints;

  for (const [path, pathItem] of Object.entries(spec.paths as any)) {
    for (const [method, operation] of Object.entries(pathItem as any)) {
      if (typeof operation !== 'object' || !operation) continue;
      
      const endpoint: Endpoint = {
        path: basePath + path,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        summary: operation.summary,
        description: operation.description,
        parameters: parseParameters(operation.parameters || []),
        tags: operation.tags,
      };

      if (operation.requestBody) {
        endpoint.requestBody = {
          schema: operation.requestBody.content?.['application/json']?.schema || {},
        };
      }

      if (operation.responses) {
        endpoint.responses = {};
        for (const [status, response] of Object.entries(operation.responses)) {
          endpoint.responses[status] = {
            schema: (response as any).content?.['application/json']?.schema || {},
          };
        }
      }

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

function parsePostmanCollection(collection: any): Endpoint[] {
  const endpoints: Endpoint[] = [];
  
  function processItems(items: any[]) {
    for (const item of items) {
      if (item.item) {
        processItems(item.item);
      } else if (item.request) {
        const request = item.request;
        const endpoint: Endpoint = {
          path: typeof request.url === 'string' ? request.url : request.url?.raw || '',
          method: request.method?.toUpperCase() || 'GET',
          summary: item.name,
          description: item.description,
        };
        
        if (request.url?.query) {
          endpoint.parameters = request.url.query.map((q: any) => ({
            name: q.key,
            in: 'query' as const,
            type: 'string',
            description: q.description,
          }));
        }
        
        endpoints.push(endpoint);
      }
    }
  }
  
  if (collection.item) {
    processItems(collection.item);
  }
  
  return endpoints;
}

function parseParameters(parameters: any[]): Endpoint['parameters'] {
  return parameters.map(param => ({
    name: param.name,
    in: param.in,
    type: param.type || param.schema?.type || 'string',
    required: param.required,
    default: param.default,
    description: param.description,
  }));
}

function parseHtmlForEndpoints(html: string, baseUrl: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  
  // Enhanced patterns for finding endpoints
  const patterns = [
    // Code blocks with HTTP methods
    /<code[^>]*>(.*?)<\/code>/gis,
    /<pre[^>]*>(.*?)<\/pre>/gis,
    // Tables with endpoints
    /<table[^>]*class="[^"]*endpoint[^"]*"[^>]*>(.*?)<\/table>/gis,
    /<table[^>]*class="[^"]*api[^"]*"[^>]*>(.*?)<\/table>/gis
  ];
  
  // HTTP method patterns
  const httpMethodRegex = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([\/\w\-\{\}\.\?=&]+)/gi;
  const curlRegex = /curl\s+[^"']*['"]([^'"]*)\b(GET|POST|PUT|DELETE|PATCH)\b[^'"]*['"][^'"]*([\/\w\-\{\}\.\?=&]+)/gi;
  const httpRequestRegex = /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([\/\w\-\{\}\.\?=&]+)\s+HTTP/gi;
  
  // Process all patterns
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const content = match[1].replace(/<[^>]*>/g, '');
      
      // Find HTTP methods in content
      let httpMatch;
      while ((httpMatch = httpMethodRegex.exec(content)) !== null) {
        const path = httpMatch[2];
        const method = httpMatch[1].toUpperCase();
        
        if (path.startsWith('/') && !endpoints.some(e => e.method === method && e.path === path)) {
          endpoints.push({
            path,
            method,
            summary: `${method} ${path}`,
            description: `Endpoint discovered from HTML documentation`
          });
        }
      }
    }
  }
  
  // Look for curl examples throughout the HTML
  let match;
  while ((match = curlRegex.exec(html)) !== null) {
    const method = match[2].toUpperCase();
    const path = match[3];
    
    if (path.startsWith('/') && !endpoints.some(e => e.method === method && e.path === path)) {
      endpoints.push({
        path,
        method,
        summary: `${method} ${path}`,
        description: `Endpoint from cURL example`
      });
    }
  }
  
  // Look for HTTP request examples
  while ((match = httpRequestRegex.exec(html)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    
    if (path.startsWith('/') && !endpoints.some(e => e.method === method && e.path === path)) {
      endpoints.push({
        path,
        method,
        summary: `${method} ${path}`,
        description: `Endpoint from HTTP request example`
      });
    }
  }
  
  // Look for API documentation tables
  const tableRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  const cellRegex = /<td[^>]*>(.*?)<\/td>/gis;
  
  while ((match = tableRegex.exec(html)) !== null) {
    const row = match[1];
    const cells = [];
    let cellMatch;
    
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]*>/g, '').trim());
    }
    
    // Check if this looks like an endpoint row (method in first cell, path in second)
    if (cells.length >= 2) {
      const method = cells[0].toUpperCase();
      const path = cells[1];
      
      if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && 
          path.startsWith('/') && 
          !endpoints.some(e => e.method === method && e.path === path)) {
        endpoints.push({
          path,
          method,
          summary: `${method} ${path}`,
          description: cells[2] || `Endpoint from documentation table`
        });
      }
    }
  }

  return endpoints;
}

// OpenAI integration for enhancing descriptions
async function enhanceWithOpenAI(endpoints: Endpoint[], apiKey: string, logs: string[]): Promise<Endpoint[]> {
  if (!apiKey || endpoints.length === 0) return endpoints;

  logs.push(`[OpenAI] Enhancing ${endpoints.length} endpoints with AI`);

  try {
    const prompt = `
Analyze these API endpoints and enhance their descriptions. Return a JSON array with the same structure but improved descriptions:

${JSON.stringify(endpoints.slice(0, 10), null, 2)}

Make descriptions concise, clear and professional. Infer functionality from method and path.
`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an API documentation expert. Enhance endpoint descriptions to be clear and professional.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const enhancedEndpoints = JSON.parse(data.choices[0].message.content);
      logs.push(`[OpenAI] Successfully enhanced endpoint descriptions`);
      return enhancedEndpoints;
    } else {
      logs.push(`[OpenAI] Failed to enhance descriptions: ${response.status}`);
    }
  } catch (error) {
    logs.push(`[OpenAI] Error enhancing descriptions: ${error.message}`);
  }

  return endpoints;
}

// Generate MCP from endpoints
function generateMcp(endpoints: Endpoint[], sourceUrls: string[]): any {
  const name = sourceUrls[0] ? new URL(sourceUrls[0]).hostname.replace(/\./g, '-') : 'generated-api';
  
  const tools = endpoints.map(endpoint => {
    const toolName = endpoint.operationId || 
      `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[\/\{\}]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '')}`;
    
    const inputSchema: any = {
      type: 'object',
      properties: {},
      required: [],
    };

    // Add parameters to input schema
    if (endpoint.parameters) {
      for (const param of endpoint.parameters) {
        if (param.in === 'query' || param.in === 'path') {
          inputSchema.properties[param.name] = {
            type: param.type,
            description: param.description,
          };
          
          if (param.required) {
            inputSchema.required.push(param.name);
          }
        }
      }
    }

    return {
      name: toolName,
      description: endpoint.summary || endpoint.description || `${endpoint.method} ${endpoint.path}`,
      method: endpoint.method,
      path: endpoint.path,
      input_schema: inputSchema,
      output_schema: endpoint.responses?.['200']?.schema || {
        type: 'object',
        description: 'API response',
      },
      examples: [
        {
          curl: `curl -X ${endpoint.method} "${endpoint.path}" -H "Authorization: Bearer \${N8N_CREDENTIALS_TOKEN}"`,
        }
      ],
    };
  });

  return {
    name,
    version: '1.0.0',
    description: `MCP gerado automaticamente a partir de documentação de API`,
    server: {
      base_url: sourceUrls[0] ? new URL(sourceUrls[0]).origin : '',
      auth: {
        type: 'bearer',
        header: 'Authorization',
        prefix: 'Bearer ',
      },
      rate_limit: {
        requests_per_minute: 60,
      },
    },
    tools,
    metadata: {
      generated_at: new Date().toISOString(),
      source_urls: sourceUrls,
    },
    n8n: {
      import_hint: 'Importar como credencial/config asset e referenciar em nodes HTTP Request.',
      env_placeholders: ['N8N_CREDENTIALS_TOKEN'],
    },
  };
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, openaiApiKey, options = {} } = await req.json();

    console.log('[McpGenerator] Starting generation for:', url);

    if (!url || !openaiApiKey) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'URL e OpenAI API Key são obrigatórios' 
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Crawl and parse API documentation
    const { endpoints, sourceUrls, logs } = await crawlApiDocumentation(url, options);
    
    if (endpoints.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Nenhum endpoint encontrado na documentação. Verifique se a URL contém documentação de API válida ou tente uma URL diferente.',
          logs,
          suggestions: [
            'Verifique se a URL aponta para documentação de API',
            'Tente URLs como /api-docs, /swagger, /openapi.json',
            'Certifique-se de que a documentação está publicamente acessível'
          ]
        }),
        { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Enhance with OpenAI
    const enhancedEndpoints = await enhanceWithOpenAI(endpoints, openaiApiKey, logs);
    
    // Generate MCP
    const mcpSpec = generateMcp(enhancedEndpoints, sourceUrls);
    
    console.log('[McpGenerator] Successfully generated MCP with', enhancedEndpoints.length, 'tools');

    return new Response(
      JSON.stringify({
        success: true,
        data: mcpSpec,
        endpoints: enhancedEndpoints,
        logs,
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('[McpGenerator] Error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Erro interno do servidor',
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});