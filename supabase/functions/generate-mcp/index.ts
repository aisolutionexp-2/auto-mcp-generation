import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Global configuration for optimization
const GLOBAL_TIMEOUT = 30000; // 30 seconds total function timeout
const HTTP_TIMEOUT = 3000; // 3 seconds per HTTP request
const MAX_PAGES = 5; // Maximum pages to process
const MAX_PARALLEL = 2; // Maximum parallel requests
const MAX_FILE_SIZE = 50 * 1024; // 50KB max file size
const OPENAI_TIMEOUT = 5000; // 5 seconds for OpenAI enhancement

// Global timer tracking
let startTime: number;
let urlCache = new Set<string>();

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

// Helper function to check if we're running out of time
function isTimeoutApproaching(): boolean {
  const elapsed = Date.now() - startTime;
  return elapsed > (GLOBAL_TIMEOUT - 5000); // 5 seconds buffer
}

// Optimized fetch with shorter timeout and size check
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = HTTP_TIMEOUT): Promise<Response> {
  if (isTimeoutApproaching()) {
    throw new Error('Global timeout approaching, aborting request');
  }

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

    // Check content size before downloading
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${contentLength} bytes (max: ${MAX_FILE_SIZE})`);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Optimized URL checking
function shouldSkipUrl(url: string): boolean {
  if (urlCache.has(url)) return true;
  
  const lowerUrl = url.toLowerCase();
  
  // Skip non-HTML files
  const skipExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.pdf'];
  if (skipExtensions.some(ext => lowerUrl.endsWith(ext))) return true;
  
  // Skip large file indicators
  if (lowerUrl.includes('download') || lowerUrl.includes('static/') || lowerUrl.includes('assets/')) return true;
  
  return false;
}

// Optimized crawler function with strict limits and timeout control
async function crawlApiDocumentation(url: string, options: any = {}): Promise<{ endpoints: Endpoint[], sourceUrls: string[], logs: string[] }> {
  const logs: string[] = [];
  const visitedUrls = new Set<string>();
  const sourceUrls: string[] = [];
  const urlsToProcess = [url]; // Use array for better control
  let allEndpoints: Endpoint[] = [];
  const maxPages = Math.min(options.maxPages || MAX_PAGES, MAX_PAGES);
  let processedPages = 0;

  logs.push(`[Crawler] Starting optimized crawl of: ${url}`);
  logs.push(`[Crawler] Max pages limit: ${maxPages}, Global timeout: ${GLOBAL_TIMEOUT}ms`);

  const baseHost = new URL(url).hostname;
  urlCache.clear(); // Reset cache for each crawl

  // Priority 1: Try to find JSON/YAML specs directly first
  const directSpecUrls = [
    new URL('/openapi.json', url).href,
    new URL('/swagger.json', url).href,
    new URL('/api-docs/swagger.json', url).href,
    new URL('/docs/openapi.json', url).href,
    new URL('/api/openapi.json', url).href,
  ];

  logs.push(`[Crawler] Phase 1: Checking direct spec URLs`);
  const directSpecPromises = directSpecUrls
    .filter(specUrl => new URL(specUrl).hostname === baseHost)
    .slice(0, 3) // Limit to first 3
    .map(async (specUrl) => {
      try {
        const response = await fetchWithTimeout(specUrl);
        if (response.ok) {
          const content = await response.text();
          const endpoints = await parseApiSpec(specUrl, content, logs);
          if (endpoints.length > 0) {
            logs.push(`[Crawler] Found ${endpoints.length} endpoints from direct spec: ${specUrl}`);
            sourceUrls.push(specUrl);
            return endpoints;
          }
        }
      } catch (error) {
        // Continue silently
      }
      return [];
    });

  const directResults = await Promise.allSettled(directSpecPromises);
  for (const result of directResults) {
    if (result.status === 'fulfilled') {
      allEndpoints = allEndpoints.concat(result.value);
    }
  }

  // If we found enough endpoints from direct specs, return early
  if (allEndpoints.length >= 5) {
    logs.push(`[Crawler] Found sufficient endpoints (${allEndpoints.length}) from direct specs, skipping HTML crawling`);
    return {
      endpoints: allEndpoints,
      sourceUrls,
      logs
    };
  }

  // Phase 2: Crawl main pages with strict limits
  logs.push(`[Crawler] Phase 2: HTML crawling with ${maxPages} page limit`);
  
  while (urlsToProcess.length > 0 && processedPages < maxPages && !isTimeoutApproaching()) {
    // Process URLs in batches for better control
    const batch = urlsToProcess.splice(0, MAX_PARALLEL);
    
    const batchPromises = batch.map(async (currentUrl) => {
      if (visitedUrls.has(currentUrl) || shouldSkipUrl(currentUrl)) {
        return { endpoints: [], newUrls: [] };
      }

      if (!isValidUrl(currentUrl) || !isSafeUrl(currentUrl)) {
        logs.push(`[Crawler] Skipping invalid/unsafe URL: ${currentUrl}`);
        return { endpoints: [], newUrls: [] };
      }

      // Only crawl within the same domain
      const currentHost = new URL(currentUrl).hostname;
      if (currentHost !== baseHost) {
        return { endpoints: [], newUrls: [] };
      }

      try {
        urlCache.add(currentUrl);
        visitedUrls.add(currentUrl);
        
        const response = await fetchWithTimeout(currentUrl);
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        
        sourceUrls.push(currentUrl);
        logs.push(`[Crawler] Processed: ${currentUrl} (${content.length} chars)`);

        const pageEndpoints: Endpoint[] = [];
        const newUrls: string[] = [];

        // Check if this is a spec file
        if (contentType.includes('application/json') || contentType.includes('application/yaml') || 
            currentUrl.includes('.json') || currentUrl.includes('.yaml') || currentUrl.includes('.yml')) {
          const endpoints = await parseApiSpec(currentUrl, content, logs);
          pageEndpoints.push(...endpoints);
          logs.push(`[Crawler] Spec file: ${endpoints.length} endpoints`);
        } else {
          // HTML processing - simplified and faster
          const htmlEndpoints = parseHtmlForEndpoints(content, currentUrl);
          pageEndpoints.push(...htmlEndpoints);

          // Only find more URLs if we haven't hit the page limit
          if (processedPages < maxPages - 1) {
            // Simplified link extraction - only look for obvious API docs
            const apiKeywords = ['swagger', 'openapi', 'api-docs', '/api/', '/docs/'];
            const simpleLinks = content.match(/href=["']([^"']+)["']/gi) || [];
            
            for (const linkMatch of simpleLinks.slice(0, 10)) { // Limit to first 10 links
              const href = linkMatch.match(/href=["']([^"']+)["']/)?.[1];
              if (href && apiKeywords.some(keyword => href.toLowerCase().includes(keyword))) {
                try {
                  const fullUrl = new URL(href, currentUrl).href;
                  if (new URL(fullUrl).hostname === baseHost && !visitedUrls.has(fullUrl)) {
                    newUrls.push(fullUrl);
                  }
                } catch (e) {
                  // Invalid URL, skip
                }
              }
            }
          }
        }

        return { endpoints: pageEndpoints, newUrls };

      } catch (error) {
        logs.push(`[Crawler] Error processing ${currentUrl}: ${error.message}`);
        return { endpoints: [], newUrls: [] };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allEndpoints = allEndpoints.concat(result.value.endpoints);
        // Add new URLs to process (but limit total)
        urlsToProcess.push(...result.value.newUrls.slice(0, 2));
      }
    }
    
    processedPages += batch.length;
    
    // Remove duplicates from urlsToProcess
    const uniqueUrls = [...new Set(urlsToProcess.filter(url => !visitedUrls.has(url)))];
    urlsToProcess.length = 0;
    urlsToProcess.push(...uniqueUrls.slice(0, maxPages - processedPages));
  }

  // Phase 3: Basic fallback if no endpoints found
  if (allEndpoints.length === 0 && !isTimeoutApproaching()) {
    logs.push(`[Crawler] Phase 3: Basic fallback strategy`);
    const commonEndpoints = await tryCommonApiPaths(url, logs);
    allEndpoints = allEndpoints.concat(commonEndpoints);
  }

  logs.push(`[Crawler] Completed. Processed ${processedPages} pages, found ${allEndpoints.length} endpoints`);
  logs.push(`[Crawler] Total time: ${Date.now() - startTime}ms`);
  
  return {
    endpoints: allEndpoints,
    sourceUrls: Array.from(visitedUrls),
    logs
  };
}

// Find documentation-related links in HTML content
function findDocumentationLinks(content: string, baseUrl: string): string[] {
  const links: string[] = [];
  const base = new URL(baseUrl);
  
  // Patterns for documentation links
  const linkPatterns = [
    /<a[^>]+href=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+href=["']([^"']+)["'][^>]*>/gi
  ];
  
  // Keywords that indicate documentation pages
  const docKeywords = [
    'api', 'docs', 'documentation', 'reference', 'guide', 'swagger', 'openapi',
    'endpoints', 'methods', 'resources', 'v1', 'v2', 'v3', 'latest', 'spec',
    'schema', 'rest', 'graphql', 'webhook', 'tutorial', 'examples'
  ];
  
  for (const pattern of linkPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const fullMatch = match[0];
        const href = match[1];
        
        // Skip anchors, external protocols, and obvious non-doc links
        if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') ||
            href.includes('javascript:') || href.startsWith('ftp:')) {
          continue;
        }
        
        const url = new URL(href, base).href;
        const urlLower = url.toLowerCase();
        const fullMatchLower = fullMatch.toLowerCase();
        
        // Check if URL or link text contains documentation keywords
        const isDocLink = docKeywords.some(keyword => 
          urlLower.includes(keyword) || fullMatchLower.includes(keyword)
        );
        
        // Also include if it's in a docs-like path structure
        const isDocPath = /\/(api|docs|documentation|reference|guide|v\d+|latest)($|\/)/i.test(url);
        
        if ((isDocLink || isDocPath) && !links.includes(url)) {
          links.push(url);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }
  
  return links;
}

// Enhanced Swagger UI config extraction
function extractSwaggerUIConfig(content: string, baseUrl: string): string[] {
  console.log('[SwaggerUI] Advanced configuration extraction...');
  const specs: string[] = [];
  const base = new URL(baseUrl);
  
  // Advanced patterns for Swagger UI detection
  const swaggerConfigPatterns = [
    // Standard SwaggerUIBundle patterns
    /SwaggerUIBundle\(\s*\{[^}]*url:\s*["']([^"']+)["']/gi,
    /SwaggerUIBundle\(\s*\{[^}]*spec:\s*["']([^"']+)["']/gi,
    
    // JavaScript variable assignments and window objects
    /(?:url|spec|openapi):\s*["']([^"']+\.(?:json|yaml|yml))["']/gi,
    /window\.ui\s*=\s*SwaggerUIBundle\(\s*\{[^}]*url:\s*["']([^"']+)["']/gi,
    
    // HTML data attributes
    /data-(?:url|spec|swagger)=["']([^"']+)["']/gi,
    
    // Script tag sources with spec files
    /<script[^>]*src=["']([^"']*(?:swagger|openapi|spec)[^"']*\.json)["']/gi,
    
    // Common patterns in documentation and config files
    /["']([^"']*\/(?:swagger|openapi|api-docs)(?:\/[^"']*)?\.json)["']/gi,
    /["']([^"']*\/v\d+\/swagger\.json)["']/gi,
    
    // Direct API endpoint patterns in content
    /\/api\/(?:v\d+\/)?(?:swagger|openapi|docs)(?:\.json)?/gi,
    
    // Configuration block patterns
    /(?:const|var|let)\s+\w+\s*=\s*\{[^}]*(?:url|spec):\s*["']([^"']+)["']/gi,
    
    // YAML frontmatter or config patterns
    /swagger[_-]?(?:ui[_-]?)?(?:url|spec):\s*["']([^"']+)["']/gi,
    
    // API documentation specific patterns
    /(?:baseURL|base_url|apiUrl|api_url):\s*["']([^"']*\/(?:swagger|openapi)[^"']*)["']/gi
  ];
  
  for (const pattern of swaggerConfigPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specUrl = match[1];
      if (specUrl && !specs.includes(specUrl)) {
        try {
          const fullUrl = new URL(specUrl, base).toString();
          specs.push(fullUrl);
          console.log(`[SwaggerUI] Found spec URL: ${fullUrl}`);
        } catch (e) {
          console.log(`[SwaggerUI] Invalid URL skipped: ${specUrl}`);
        }
      }
    }
  }
  
  // Also look for inline JSON specs
  const inlineSpecMatch = content.match(/(?:spec|swagger|openapi):\s*(\{[\s\S]*?\}),?\s*(?:dom_id|url|plugins)/i);
  if (inlineSpecMatch) {
    console.log('[SwaggerUI] Found inline spec definition');
    try {
      const inlineSpec = JSON.parse(inlineSpecMatch[1]);
      if (inlineSpec.paths) {
        specs.push('inline-spec');
      }
    } catch (e) {
      console.log('[SwaggerUI] Failed to parse inline spec');
    }
  }
  
  // Extract from JavaScript variables and function calls
  const jsVarPatterns = [
    /(?:spec|config|options)\.url\s*=\s*["']([^"']+)["']/gi,
    /(?:spec|config|options)\["url"\]\s*=\s*["']([^"']+)["']/gi,
    /fetch\(\s*["']([^"']*swagger[^"']*)["']/gi,
    /axios\.get\(\s*["']([^"']*swagger[^"']*)["']/gi
  ];
  
  for (const pattern of jsVarPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specUrl = match[1];
      try {
        const fullUrl = new URL(specUrl, base).toString();
        if (!specs.includes(fullUrl)) {
          specs.push(fullUrl);
          console.log(`[SwaggerUI] Found JS variable spec: ${fullUrl}`);
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
  console.log('[Parser] Advanced HTML parsing for API endpoints...');
  const endpoints: Endpoint[] = [];
  
  // Advanced endpoint extraction patterns targeting Swagger UI specifically
  const patterns = [
    // Swagger UI DOM structure patterns (most specific first)
    /<div[^>]*class="[^"]*opblock[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*opblock-summary-method[^"]*"[^>]*>(GET|POST|PUT|DELETE|PATCH)<\/span>[\s\S]*?<span[^>]*class="[^"]*opblock-summary-path[^"]*"[^>]*>([^<]+)<\/span>/gi,
    
    // Table-based documentation
    /<tr[^>]*>[\s\S]*?<td[^>]*>(GET|POST|PUT|DELETE|PATCH)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>/gi,
    
    // Code blocks with curl examples
    /curl[^"']*-X\s+(GET|POST|PUT|DELETE|PATCH)[^"']*["']([^"']+)["']/gi,
    
    // REST endpoint patterns in text
    /(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s<>'"]*)/gi,
    
    // API endpoint patterns in href attributes
    /href=["']([^"']*\/api\/[^"']*)["']/gi,
    
    // JSON examples with endpoint references
    /"(?:url|endpoint|path)":\s*["']([^"']*\/[^"']*)["']/gi,
    
    // OpenAPI operation objects in script tags
    /<script[^>]*>[\s\S]*?"(\/[^"]*)":\s*\{[\s\S]*?"(get|post|put|delete|patch)"/gi,
    
    // More specific patterns for different documentation styles
    /<code[^>]*>(.*?)<\/code>/gis,
    /<pre[^>]*>(.*?)<\/pre>/gis
  ];
  
  // Extract endpoints using targeted patterns
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let method = '';
      let path = '';
      let summary = '';
      
      // Handle different match groups based on pattern
      if (pattern.source.includes('opblock')) {
        method = match[1];
        path = match[2].trim();
        summary = 'Extracted from Swagger UI DOM';
      } else if (pattern.source.includes('<tr')) {
        method = match[1];
        path = match[2].trim();
        summary = 'Extracted from documentation table';
      } else if (pattern.source.includes('curl')) {
        method = match[1];
        path = match[2];
        summary = 'Extracted from curl example';
      } else if (pattern.source.includes('href')) {
        path = match[1];
        method = 'GET'; // Default for href links
        summary = 'Extracted from API link';
      } else if (pattern.source.includes('script')) {
        path = match[1];
        method = match[2].toUpperCase();
        summary = 'Extracted from OpenAPI schema';
      } else if (pattern.source.includes('GET|POST')) {
        method = match[1];
        path = match[2];
        summary = 'Extracted from HTTP method pattern';
      } else {
        // Handle code/pre blocks
        const content = match[1].replace(/<[^>]*>/g, '');
        const methodMatch = content.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/i);
        const pathMatch = content.match(/(\/[^\s<>'"]*)/);
        
        if (methodMatch && pathMatch) {
          method = methodMatch[1].toUpperCase();
          path = pathMatch[1];
          summary = 'Extracted from code block';
        }
      }
      
      // Clean and validate path
      path = path.trim().replace(/\s+/g, '');
      if (path.startsWith('/') && method && !endpoints.some(e => e.path === path && e.method === method)) {
        endpoints.push({
          path,
          method: method.toUpperCase(),
          summary,
          description: `Found in HTML content at ${baseUrl}`,
        });
      }
    }
  }
  
  // Try to extract from swagger-ui specific DOM structures
  const swaggerOperations = html.match(/<div[^>]*class="[^"]*operation[^"]*"[^>]*>[\s\S]*?<\/div>/gi);
  if (swaggerOperations) {
    for (const operation of swaggerOperations) {
      const methodMatch = operation.match(/class="[^"]*opblock-summary-method[^"]*"[^>]*>([^<]+)/);
      const pathMatch = operation.match(/class="[^"]*opblock-summary-path[^"]*"[^>]*>([^<]+)/);
      const summaryMatch = operation.match(/class="[^"]*opblock-summary[^"]*"[^>]*>([^<]+)/);
      
      if (methodMatch && pathMatch) {
        const method = methodMatch[1].trim().toUpperCase();
        const path = pathMatch[1].trim();
        const summary = summaryMatch ? summaryMatch[1].trim() : 'Swagger UI operation';
        
        if (path.startsWith('/') && !endpoints.some(e => e.path === path && e.method === method)) {
          endpoints.push({
            path,
            method,
            summary,
            description: 'Extracted from Swagger UI operation block'
          });
        }
      }
    }
  }
  
  // Enhanced pattern matching for endpoints in JavaScript/JSON content
  const jsPatterns = [
    /"(\/api\/[^"]+)"/gi,
    /"(\/v\d+\/[^"]+)"/gi,
    /path:\s*["']([^"']+)["']/gi,
    /endpoint:\s*["']([^"']+)["']/gi,
    /'(\/api\/[^']+)'/gi,
    /'(\/v\d+\/[^']+)'/gi,
  ];
  
  for (const pattern of jsPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const path = match[1];
      if (path.startsWith('/') && path.length > 1 && !endpoints.some(e => e.path === path)) {
        endpoints.push({
          path,
          method: 'GET', // Default method
          summary: 'GET ' + path,
          description: 'Endpoint extracted from JavaScript content'
        });
      }
    }
  }
  
  // Look for method-path pairs in tables more aggressively
  const tableRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
  if (tableRows) {
    for (const row of tableRows) {
      const cells = row.match(/<t[hd][^>]*>([^<]*)<\/t[hd]>/gi);
      if (cells && cells.length >= 2) {
        const cleanCells = cells.map(cell => cell.replace(/<[^>]*>/g, '').trim());
        
        // Look for method-path combinations
        for (let i = 0; i < cleanCells.length - 1; i++) {
          const method = cleanCells[i].toUpperCase();
          const path = cleanCells[i + 1];
          
          if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method) && 
              path.startsWith('/') && 
              !endpoints.some(e => e.method === method && e.path === path)) {
            endpoints.push({
              path,
              method,
              summary: `${method} ${path}`,
              description: cleanCells[i + 2] || 'Endpoint from documentation table'
            });
          }
        }
      }
    }
  }
  
  console.log(`[Parser] Found ${endpoints.length} endpoints from advanced HTML parsing`);
  return endpoints;
}

// Enhanced Firecrawl integration for comprehensive documentation scraping
async function crawlWithFirecrawl(url: string, logs: string[]): Promise<Endpoint[]> {
  const endpoints: Endpoint[] = [];
  
  try {
    logs.push(`[Firecrawl] Starting enhanced crawl of: ${url}`);
    
    // Make a direct request to Firecrawl API
    const firecrawlResponse = await fetch('https://api.firecrawl.dev/v0/crawl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('FIRECRAWL_API_KEY') || 'fc-your-key-here'}`
      },
      body: JSON.stringify({
        url: url,
        crawlerOptions: {
          limit: 20,
          maxDepth: 3,
          includeSubdomains: false
        },
        pageOptions: {
          onlyMainContent: true,
          includeHtml: true,
          extractorOptions: {
            mode: 'llm-extraction',
            extractionPrompt: `Extract all API endpoints, HTTP methods, paths, and descriptions from this API documentation. 
                              Look for:
                              - OpenAPI/Swagger specifications
                              - REST API endpoints 
                              - HTTP methods (GET, POST, PUT, DELETE, etc.)
                              - API paths and routes
                              - cURL examples
                              - Request/response examples
                              Return structured data about each endpoint found.`
          }
        }
      })
    });

    if (firecrawlResponse.ok) {
      const data = await firecrawlResponse.json();
      logs.push(`[Firecrawl] Crawl initiated successfully, job ID: ${data.jobId}`);
      
      // Poll for results
      let attempts = 0;
      const maxAttempts = 30; // 5 minutes max
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
        
        const statusResponse = await fetch(`https://api.firecrawl.dev/v0/crawl/status/${data.jobId}`, {
          headers: {
            'Authorization': `Bearer ${Deno.env.get('FIRECRAWL_API_KEY') || 'fc-your-key-here'}`
          }
        });
        
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          
          if (status.status === 'completed') {
            logs.push(`[Firecrawl] Crawl completed, processing ${status.data?.length || 0} pages`);
            
            // Process the crawled data
            for (const page of status.data || []) {
              if (page.html || page.content) {
                const pageEndpoints = parseHtmlForEndpoints(page.html || page.content, page.url || url);
                endpoints.push(...pageEndpoints);
                
                // Also try to parse extracted data if available
                if (page.extract && typeof page.extract === 'object') {
                  const extractedEndpoints = parseExtractedApiData(page.extract);
                  endpoints.push(...extractedEndpoints);
                }
              }
            }
            
            logs.push(`[Firecrawl] Extracted ${endpoints.length} endpoints from Firecrawl data`);
            break;
          } else if (status.status === 'failed') {
            logs.push(`[Firecrawl] Crawl failed: ${status.error || 'Unknown error'}`);
            break;
          }
          
          logs.push(`[Firecrawl] Crawl status: ${status.status}, progress: ${status.current}/${status.total}`);
        }
        
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        logs.push(`[Firecrawl] Crawl timeout after ${maxAttempts} attempts`);
      }
      
    } else {
      logs.push(`[Firecrawl] API request failed: ${firecrawlResponse.status} ${firecrawlResponse.statusText}`);
    }
    
  } catch (error) {
    logs.push(`[Firecrawl] Error: ${error.message}`);
  }
  
  return endpoints;
}

// Parse extracted API data from Firecrawl LLM extraction
function parseExtractedApiData(extractedData: any): Endpoint[] {
  const endpoints: Endpoint[] = [];
  
  if (Array.isArray(extractedData)) {
    for (const item of extractedData) {
      if (item.path && item.method) {
        endpoints.push({
          path: item.path,
          method: item.method.toUpperCase(),
          summary: item.summary || item.description || `${item.method} ${item.path}`,
          description: item.description || `Endpoint extracted via AI`
        });
      }
    }
  }
  
  return endpoints;
}
async function enhanceWithOpenAI(endpoints: Endpoint[], apiKey: string, logs: string[]): Promise<Endpoint[]> {
  console.log('[OpenAI] Enhancing endpoints with AI...');
  logs.push(`[OpenAI] Enhancing ${endpoints.length} endpoints with AI`);
  
  if (!apiKey || endpoints.length === 0) {
    return endpoints;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an API documentation expert. Enhance API endpoint descriptions to be clear and useful. Always respond with valid JSON only - no markdown formatting, no code blocks, no explanatory text.'
          },
          {
            role: 'user',
            content: `Enhance these API endpoints with better descriptions, summaries, and parameter information. Return ONLY the JSON array:\n\n${JSON.stringify(endpoints.slice(0, 20), null, 2)}`
          }
        ],
        temperature: 0.1,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    // Clean up markdown formatting if present
    content = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    
    // Try to find JSON array in the response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }
    
    try {
      const enhancedEndpoints = JSON.parse(content);
      if (Array.isArray(enhancedEndpoints) && enhancedEndpoints.length > 0) {
        logs.push('[OpenAI] Successfully enhanced endpoint descriptions');
        return enhancedEndpoints;
      } else {
        logs.push('[OpenAI] Enhanced response was not a valid array, using original endpoints');
        return endpoints;
      }
    } catch (parseError) {
      logs.push(`[OpenAI] JSON parse error: ${parseError.message}, using original endpoints`);
      console.log('[OpenAI] Raw content that failed to parse:', content.substring(0, 500));
      return endpoints;
    }
  } catch (error) {
    logs.push(`[OpenAI] Error: ${error.message}`);
    return endpoints;
  }
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
    // Initialize global timer
    startTime = Date.now();
    
    const { url, openaiApiKey, options = {} } = await req.json();
    console.log('[McpGenerator] Starting optimized generation for:', url);
    console.log('[McpGenerator] Global timeout:', GLOBAL_TIMEOUT, 'ms');

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

    // Set up global timeout handler for graceful shutdown
    const globalTimeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          isTimeout: true,
          endpoints: [],
          sourceUrls: [],
          logs: ['[Global] Function timeout reached, returning partial results']
        });
      }, GLOBAL_TIMEOUT - 1000); // 1 second buffer
    });

    // Race between crawling and global timeout
    const crawlPromise = crawlApiDocumentation(url, {
      ...options,
      maxPages: Math.min(options.maxPages || MAX_PAGES, MAX_PAGES)
    });

    const result = await Promise.race([crawlPromise, globalTimeoutPromise]);
    
    let { endpoints, sourceUrls, logs } = result as any;
    const isTimeout = result.isTimeout;

    if (isTimeout) {
      logs.push(`[Global] Function timed out after ${GLOBAL_TIMEOUT}ms`);
    }
    
    if (endpoints.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: isTimeout ? 
            'Timeout atingido durante o processamento. A documentação pode ser muito complexa.' :
            'Nenhum endpoint encontrado na documentação. Verifique se a URL contém documentação de API válida.',
          logs,
          suggestions: isTimeout ? [
            'Tente uma URL mais específica (ex: /openapi.json)',
            'Verifique se há arquivos de spec JSON/YAML diretos',
            'Use uma documentação com menos páginas'
          ] : [
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

    // Only enhance with OpenAI if we have time left
    let enhancedEndpoints = endpoints;
    if (!isTimeoutApproaching() && !isTimeout) {
      try {
        const startEnhancement = Date.now();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('OpenAI timeout')), OPENAI_TIMEOUT);
        });
        
        const enhancePromise = enhanceWithOpenAI(endpoints, openaiApiKey, logs);
        enhancedEndpoints = await Promise.race([enhancePromise, timeoutPromise]);
        
        logs.push(`[OpenAI] Enhancement completed in ${Date.now() - startEnhancement}ms`);
      } catch (error) {
        logs.push(`[OpenAI] Enhancement skipped due to timeout or error: ${error.message}`);
      }
    } else {
      logs.push('[OpenAI] Enhancement skipped due to time constraints');
    }
    
    // Generate MCP
    const mcpSpec = generateMcp(enhancedEndpoints, sourceUrls);
    
    const totalTime = Date.now() - startTime;
    logs.push(`[McpGenerator] Completed in ${totalTime}ms`);
    console.log('[McpGenerator] Successfully generated MCP with', enhancedEndpoints.length, 'tools');

    return new Response(
      JSON.stringify({
        success: true,
        data: mcpSpec,
        endpoints: enhancedEndpoints,
        logs,
        metadata: {
          processingTime: totalTime,
          timeoutReached: isTimeout,
          endpointsFound: enhancedEndpoints.length
        }
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error('[McpGenerator] Error after', totalTime, 'ms:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Erro interno do servidor',
        metadata: {
          processingTime: totalTime,
          errorType: error.name || 'Unknown'
        }
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});