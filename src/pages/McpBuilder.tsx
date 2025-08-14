import React, { useState, useCallback } from 'react';
import { Download, AlertCircle, CheckCircle, Loader2, Globe, Key, Settings, Eye, Filter } from 'lucide-react';
import type { Endpoint, McpTool, McpSpec } from '@/types/mcp';

interface CrawlResult {
  endpoints: Endpoint[];
  baseUrl: string;
  authType?: string;
  sourceUrls: string[];
  detectedSpecs: string[];
}

// Mock OpenAI API call
const mockOpenAICall = async (prompt: string, apiKey: string): Promise<string> => {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!apiKey.startsWith('sk-')) {
    throw new Error('Invalid OpenAI API key format');
  }
  if (prompt.includes('description')) {
    return 'Retrieves a list of users with optional pagination parameters';
  }
  if (prompt.includes('schema')) {
    return JSON.stringify({
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' }
      }
    });
  }
  return 'Generated content based on API documentation';
};

// Enhanced YAML parser for OpenAPI specs (very lenient)
const parseYAMLContent = (yamlContent: string): any => {
  try {
    const lines = yamlContent.split('\n');
    const result: any = {};
    const stack: Array<{ obj: any; indent: number }> = [{ obj: result, indent: -1 }];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const content = line.trim();
      if (content.startsWith('- ')) {
        const value = content.substring(2).trim();
        const current = stack[stack.length - 1].obj;
        if (!Array.isArray(current)) {
          Object.setPrototypeOf(current, Array.prototype);
          (current as any).length = 0;
        }
        if (value.includes(':')) {
          const [key, val] = value.split(':').map(s => s.trim());
          const newObj: any = {};
          newObj[key] = val.replace(/['"]/g, '') || null;
          (current as any).push(newObj);
        } else {
          (current as any).push(value.replace(/['"]/g, ''));
        }
        continue;
      }
      if (content.includes(':')) {
        const colonIndex = content.indexOf(':');
        const key = content.substring(0, colonIndex).trim();
        const value = content.substring(colonIndex + 1).trim();
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }
        const current = stack[stack.length - 1].obj;
        if (value === '' || value === '{}' || value === '[]') {
          (current as any)[key] = value === '[]' ? [] : {};
          stack.push({ obj: (current as any)[key], indent });
        } else {
          let parsedValue: any = value.replace(/['"]/g, '');
          if (parsedValue === 'true') parsedValue = true;
          else if (parsedValue === 'false') parsedValue = false;
          else if (parsedValue === 'null') parsedValue = null;
          else if (/^\d+$/.test(parsedValue)) parsedValue = parseInt(parsedValue);
          else if (/^\d+\.\d+$/.test(parsedValue)) parsedValue = parseFloat(parsedValue);
          (current as any)[key] = parsedValue;
        }
      }
    }
    return result;
  } catch (error) {
    console.error('[McpBuilder] YAML parsing error:', error);
    throw error;
  }
};

// Generate operation ID from method and path
const generateOperationId = (method: string, path: string): string => {
  const cleanPath = path
    .replace(/[^a-zA-Z0-9\/]/g, '')
    .split('/')
    .filter(part => part && !part.startsWith('{'))
    .join('_');
  return `${method.toLowerCase()}_${cleanPath}`.replace(/_{2,}/g, '_');
};

// Generate description from path and method
const generateDescriptionFromPath = (path: string, method: string): string => {
  const pathParts = path.split('/').filter(part => part && !part.startsWith('{'));
  const resource = pathParts[pathParts.length - 1] || 'resource';
  const methodDescriptions: Record<string, string> = {
    GET: `Retrieve ${resource}`,
    POST: `Create new ${resource}`,
    PUT: `Update ${resource}`,
    PATCH: `Partially update ${resource}`,
    DELETE: `Delete ${resource}`,
    HEAD: `Get ${resource} headers`,
    OPTIONS: `Get ${resource} options`
  } as any;
  return (methodDescriptions as any)[method] || `${method} ${path}`;
};

// Extract tags from path structure
const extractTagsFromPath = (path: string): string[] => {
  const pathParts = path.split('/').filter(part => part && !part.startsWith('{') && !part.includes('.'));
  const tag = pathParts[1] || pathParts[0] || 'general';
  return [tag.toLowerCase().replace(/[^a-z0-9]/g, '')];
};

// Extract parameters from path
const extractParametersFromPath = (path: string): any[] => {
  const parameters: any[] = [];
  const pathParams = path.match(/\{([^}]+)\}/g);
  if (pathParams) {
    pathParams.forEach(param => {
      const paramName = param.replace(/[{}]/g, '');
      parameters.push({
        name: paramName,
        in: 'path',
        type: 'string',
        required: true,
        description: `Path parameter: ${paramName}`
      });
    });
  }
  return parameters;
};

// Extract base URL from documentation
const extractBaseUrl = (html: string, documentationUrl: string): string => {
  const patterns = [
    /baseUrl['":\s]*['"]([^'"]+)['"]/i,
    /base_url['":\s]*['"]([^'"]+)['"]/i,
    /host['":\s]*['"]([^'"]+)['"]/i,
    /servers?['":\s]*\[[^}]*url['":\s]*['"]([^'"]+)['"]/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      let baseUrl = match[1];
      if (!baseUrl.startsWith('http')) {
        const docUrl = new URL(documentationUrl);
        baseUrl = docUrl.origin + (baseUrl.startsWith('/') ? baseUrl : '/' + baseUrl);
      }
      return baseUrl;
    }
  }
  const docUrl = new URL(documentationUrl);
  return docUrl.origin + '/api';
};

// Detect authentication type from HTML
const detectAuthType = (html: string): string => {
  if (html.includes('bearer') || html.includes('Bearer')) return 'bearer';
  if (html.includes('api-key') || html.includes('apikey')) return 'apikey';
  if (html.includes('oauth') || html.includes('OAuth')) return 'oauth';
  return 'bearer';
};

// Infer a JSON schema from an example object
const inferJsonSchemaFromExample = (example: any): any => {
  if (example === null) return { type: 'null' };
  const type = Array.isArray(example) ? 'array' : typeof example;
  if (type === 'array') {
    const firstItem = example.length > 0 ? example[0] : null;
    return {
      type: 'array',
      items: firstItem ? inferJsonSchemaFromExample(firstItem) : {}
    };
  }
  if (type === 'object') {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    Object.keys(example).forEach(key => {
      required.push(key);
      properties[key] = inferJsonSchemaFromExample(example[key]);
    });
    return { type: 'object', properties, required };
  }
  if (type === 'number') return { type: Number.isInteger(example) ? 'integer' : 'number' };
  if (type === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
};

// Try to extract request body JSON from curl text
const extractRequestBodyFromCurl = (text: string): any | null => {
  try {
    const dataRegex = /(?:-d|--data|-\-data-raw|--data-binary)\s+(?:@[^\s]+|(['"])(\{[\s\S]*?\})\1)/i;
    const match = dataRegex.exec(text);
    if (match && match[2]) {
      const jsonString = match[2];
      try {
        return JSON.parse(jsonString);
      } catch {
        // Try to fix common issues like trailing commas
        const fixed = jsonString
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/\s+/g, ' ');
        return JSON.parse(fixed);
      }
    }
    return null;
  } catch {
    return null;
  }
};

// Generate curl example for endpoint
const generateCurlExample = (method: string, path: string, parameters: any[], baseUrl: string): string => {
  try {
    let curl = `curl -X ${method}`;
    curl += ` -H "Content-Type: application/json"`;
    curl += ` -H "Authorization: Bearer \${N8N_CREDENTIALS_TOKEN}"`;
    let finalPath = path;
    const queryParams: string[] = [];
    if (parameters && Array.isArray(parameters)) {
      parameters.forEach(param => {
        if (param.in === 'path') {
          finalPath = finalPath.replace(`{${param.name}}`, `\${${param.name}}`);
        } else if (param.in === 'query') {
          queryParams.push(`${param.name}=\${${param.name}}`);
        }
      });
    }
    const finalBaseUrl = baseUrl || '\${N8N_BASE_URL}';
    let finalUrl = `${finalBaseUrl}${finalPath}`;
    if (queryParams.length > 0) {
      finalUrl += `?${queryParams.join('&')}`;
    }
    curl += ` "${finalUrl}"`;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      curl += ` -d '{"key": "value"}'`;
    }
    return curl;
  } catch (error) {
    console.warn('[McpBuilder] Failed to generate curl example:', error);
    return `curl -H "Authorization: Bearer \${N8N_CREDENTIALS_TOKEN}" "${baseUrl || '\${N8N_BASE_URL}'}${path}"`;
  }
};

// Call OpenAI Chat API to assist crawling (best-effort; falls back silently)
const callOpenAIChat = async (prompt: string, apiKey: string): Promise<string> => {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that outputs concise JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0
      })
    } as RequestInit);
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return content;
  } catch (err) {
    console.warn('[McpBuilder] OpenAI call failed, continuing without LLM assist:', err);
    return '';
  }
};

// Use LLM to suggest more relevant documentation links on the same origin
const llmSuggestLinks = async (html: string, baseUrl: string, apiKey: string): Promise<string[]> => {
  try {
    const origin = new URL(baseUrl).origin;
    const prompt = `Given the following documentation HTML (truncated), list up to 15 href links (absolute or relative) that are likely to contain API endpoint definitions, reference pages, or OpenAPI/Swagger specs. Return JSON with a single field \"links\": string[]. Only include links that belong to the same site.\n\nHTML:\n${html.slice(0, 12000)}`;
    const raw = await callOpenAIChat(prompt, apiKey);
    const match = raw.match(/\{[\s\S]*\}/);
    const json = match ? match[0] : raw;
    const parsed = JSON.parse(json);
    const links: string[] = Array.isArray(parsed.links) ? parsed.links : [];
    return links
      .map(l => {
        try {
          if (l.startsWith('http')) return new URL(l).href;
          return new URL(l, origin).href;
        } catch { return ''; }
      })
      .filter(l => !!l && l.startsWith(origin));
  } catch {
    return [];
  }
};

// Extract in-page links likely relevant to API docs
const extractLinksFromHtml = (html: string, baseUrl: string): string[] => {
  try {
    const origin = new URL(baseUrl).origin;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const keywords = ['api', 'docs', 'swagger', 'openapi', 'reference', 'endpoint', 'v1', 'v2', 'rest', 'graphql'];
    const links = anchors
      .map(a => a.getAttribute('href') || '')
      .filter(href => href && !href.startsWith('#'))
      .map(href => {
        try {
          if (href.startsWith('http')) return new URL(href).href;
          return new URL(href, baseUrl).href;
        } catch { return ''; }
      })
      .filter(u => !!u && u.startsWith(origin))
      .filter(u => keywords.some(k => u.toLowerCase().includes(k)))
      .slice(0, 50);
    return Array.from(new Set(links));
  } catch {
    return [];
  }
};

// Fetch a page using multiple strategies
const fetchPageWithStrategies = async (url: string): Promise<string> => {
  const strategies = [
    async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache'
        },
        mode: 'cors',
        credentials: 'omit'
      } as RequestInit);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    async () => {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`Proxy failed: ${response.status}`);
      const data = await response.json();
      return data.contents;
    }
  ];
  for (const strategy of strategies) {
    try { const html = await strategy(); if (html && html.length > 50) return html; } catch { continue; }
  }
  return '';
};

// Enhanced HTML documentation parser
const parseHTMLDocumentation = async (html: string, baseUrl: string): Promise<Endpoint[]> => {
  const endpoints: Endpoint[] = [];
  try {
    console.log('[McpBuilder] Starting comprehensive HTML parsing');
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const textContent = doc.body.textContent || '';
    const endpointPatterns = [
      /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([\/\w\-\{\}\.\:]+)/gi,
      /([\/\w\-\{\}\.\:]+)\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/gi,
      /(\/\/(?:api|v\d+|[a-z_]+)\/[\w\-\/\{\}\.\:]+)/gi,
      /operationId['":\s]*['"]([^'\"]+)['\"]/gi,
      /['"`]([\/\w\-\{\}\.\:]+)['"`]/gi,
      /(?:href|action|url)[=:\s]*['"]([\/\w\-\{\}\.\:]+)['"]/gi
    ];
    const foundEndpoints = new Map<string, Set<string>>();
    const sampleSchemas = new Map<string, any>();
    for (const pattern of endpointPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(textContent)) !== null) {
        let path = '';
        let method = 'GET';
        if (match[1] && match[2]) {
          if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(match[1].toUpperCase())) {
            method = match[1].toUpperCase();
            path = match[2];
          } else if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(match[2].toUpperCase())) {
            path = match[1];
            method = match[2].toUpperCase();
          } else {
            path = match[1];
          }
        } else if (match[1]) {
          path = match[1];
        }
        if (path && path.startsWith('/') && path.length > 1 && !path.includes(' ')) {
          path = path.replace(/['"`;,:\s]+$/, '').replace(/^['"`;,:\s]+/, '');
          if (!foundEndpoints.has(path)) {
            foundEndpoints.set(path, new Set());
          }
          foundEndpoints.get(path)!.add(method);
        }
      }
    }
    const tables = doc.querySelectorAll('table');
    tables.forEach(table => {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const cellTexts = Array.from(cells).map(cell => cell.textContent?.trim() || '');
          for (let i = 0; i < cellTexts.length; i++) {
            for (let j = 0; j < cellTexts.length; j++) {
              if (i === j) continue;
              const text1 = cellTexts[i];
              const text2 = cellTexts[j];
              const methodMatch = text1.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i);
              const pathMatch = text2.match(/^(\/[\w\-\/\{\}\.\:]*)/);
              if (methodMatch && pathMatch) {
                const method = methodMatch[1].toUpperCase();
                const path = pathMatch[1];
                if (!foundEndpoints.has(path)) {
                  foundEndpoints.set(path, new Set());
                }
                foundEndpoints.get(path)!.add(method);
              }
            }
          }
        }
      });
    });
    const codeElements = doc.querySelectorAll('code, pre, .highlight, .code, .example');
    codeElements.forEach(element => {
      const text = element.textContent || '';
      const curlPattern = /curl\s+[^\n]*?(?:-X\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS))?[^\n]*?(https?:\/\/[^\s'\"]+|\/[\w\-\/\{\}\.\:]+)/gi;
      let curlMatch: RegExpExecArray | null;
      while ((curlMatch = curlPattern.exec(text)) !== null) {
        const method = curlMatch[1] ? curlMatch[1].toUpperCase() : 'GET';
        let urlOrPath = curlMatch[2];
        try {
          if (urlOrPath.startsWith('http')) {
            const url = new URL(urlOrPath);
            urlOrPath = url.pathname;
          }
          if (urlOrPath.startsWith('/') && urlOrPath.length > 1) {
            if (!foundEndpoints.has(urlOrPath)) {
              foundEndpoints.set(urlOrPath, new Set());
            }
            foundEndpoints.get(urlOrPath)!.add(method);
            // Try to extract request body from the same curl block
            const body = extractRequestBodyFromCurl(text);
            if (body) {
              const key = `${method}:${urlOrPath}`;
              sampleSchemas.set(key, inferJsonSchemaFromExample(body));
            }
          }
        } catch {
          // ignore invalid URL
        }
      }
      const httpPattern = /(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([\/\w\-\{\}\.\:]+)/gi;
      let httpMatch: RegExpExecArray | null;
      while ((httpMatch = httpPattern.exec(text)) !== null) {
        const method = httpMatch[1].toUpperCase();
        const path = httpMatch[2];
        if (path.startsWith('/')) {
          if (!foundEndpoints.has(path)) {
            foundEndpoints.set(path, new Set());
          }
          foundEndpoints.get(path)!.add(method);
        }
      }
    });
    foundEndpoints.forEach((methods, path) => {
      methods.forEach(method => {
        const description = generateDescriptionFromPath(path, method);
        const tags = extractTagsFromPath(path);
        const parameters = extractParametersFromPath(path);
        const key = `${method}:${path}`;
        const schema = sampleSchemas.get(key);
        const endpoint: Endpoint = {
          path,
          method,
          operationId: generateOperationId(method, path),
          description,
          parameters,
          tags,
          requestBody: schema ? { schema } as any : undefined
        } as Endpoint;
        endpoints.push(endpoint);
      });
    });
    endpoints.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
    console.log(`[McpBuilder] HTML parsing completed: found ${endpoints.length} endpoints from ${endpoints.length} method-path combos`);
    return endpoints;
  } catch (error) {
    console.error('[McpBuilder] HTML parsing error:', error);
    return [];
  }
};

// Enhanced OpenAPI/Swagger specification parser
const parseOpenAPISpec = async (content: string, sourceUrl: string): Promise<Endpoint[]> => {
  try {
    let spec: any;
    try {
      spec = JSON.parse(content);
    } catch {
      try {
        spec = parseYAMLContent(content);
      } catch {
        console.warn('[McpBuilder] Failed to parse spec as JSON or YAML');
        return [];
      }
    }
    if (!spec || (!spec.paths && !spec.swagger && !spec.openapi)) {
      console.warn('[McpBuilder] Invalid OpenAPI/Swagger spec structure');
      return [];
    }
    const endpoints: Endpoint[] = [];
    console.log('[McpBuilder] Parsing OpenAPI spec with', Object.keys(spec.paths || {}).length, 'paths');
    let baseUrl = '';
    if (spec.servers && spec.servers[0]) {
      baseUrl = spec.servers[0].url;
    } else if (spec.host) {
      const scheme = spec.schemes && spec.schemes[0] ? spec.schemes[0] : 'https';
      const basePath = spec.basePath || '';
      baseUrl = `${scheme}://${spec.host}${basePath}`;
    }
    for (const [path, pathObj] of Object.entries(spec.paths || {})) {
      if (!pathObj || typeof pathObj !== 'object') continue;
      const pathParameters = (pathObj as any).parameters || [];
      for (const [method, operation] of Object.entries(pathObj as Record<string, any>)) {
        const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
        if (!httpMethods.includes(method.toLowerCase())) continue;
        if (!operation || typeof operation !== 'object') continue;
        const allParameters = [
          ...pathParameters,
          ...(operation.parameters || [])
        ];
        let requestBodySchema = null as any;
        if (operation.requestBody) {
          const content = operation.requestBody.content;
          if (content) {
            const contentTypes = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'];
            for (const contentType of contentTypes) {
              if (content[contentType] && content[contentType].schema) {
                requestBodySchema = content[contentType].schema;
                break;
              }
            }
          }
        }
        const responses = operation.responses || {};
        let responseSchema = null as any;
        const successCodes = ['200', '201', '202', '204'];
        for (const code of successCodes) {
          if (responses[code] && responses[code].content) {
            const responseContent = responses[code].content;
            if (responseContent['application/json'] && responseContent['application/json'].schema) {
              responseSchema = responseContent['application/json'].schema;
              break;
            }
          }
        }
        if (!responseSchema && responses.default && responses.default.content) {
          const defaultContent = responses.default.content;
          if (defaultContent['application/json'] && defaultContent['application/json'].schema) {
            responseSchema = defaultContent['application/json'].schema;
          }
        }
        const examples: any[] = [];
        if (operation.examples) {
          examples.push(...Object.values(operation.examples));
        }
        const curlExample = generateCurlExample(method.toUpperCase(), path, allParameters, baseUrl);
        if (curlExample) {
          examples.push({ curl: curlExample });
        }
        const endpoint: Endpoint = {
          path: path as string,
          method: method.toUpperCase(),
          operationId: operation.operationId || generateOperationId(method, path as string),
          description: operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
          parameters: allParameters,
          requestBody: requestBodySchema ? { schema: requestBodySchema } as any : undefined,
          responses: responseSchema ? { '200': { schema: responseSchema } } as any : responses,
          tags: operation.tags || extractTagsFromPath(path as string)
        } as Endpoint;
        endpoints.push(endpoint);
      }
    }
    console.log('[McpBuilder] Successfully parsed OpenAPI spec:', endpoints.length, 'endpoints');
    return endpoints;
  } catch (error) {
    console.error('[McpBuilder] Failed to parse OpenAPI spec:', error);
    return [];
  }
};

// Find OpenAPI/Swagger spec URLs
const findSpecUrls = async (html: string, baseUrl: string): Promise<string[]> => {
  const urls: string[] = [];
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const commonPaths = [
    '/swagger.json', '/swagger.yaml', '/swagger.yml',
    '/openapi.json', '/openapi.yaml', '/openapi.yml',
    '/api-docs', '/api-docs.json', '/api-docs.yaml',
    '/api/swagger.json', '/api/swagger.yaml',
    '/api/openapi.json', '/api/openapi.yaml',
    '/docs/swagger.json', '/docs/openapi.json'
  ];
  for (const path of commonPaths) {
    urls.push(origin + path);
  }
  const linkRegexes = [
    /["']([^"']*(?:swagger|openapi)[^"']*\.(?:json|yaml|yml))["']/gi,
    /url:\s*["']([^"']*(?:swagger|openapi)[^"']*)["']/gi,
    /configUrl:\s*["']([^"']*)["']/gi
  ];
  for (const regex of linkRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      let specUrl = match[1];
      if (specUrl.startsWith('/')) {
        specUrl = origin + specUrl;
      } else if (!specUrl.startsWith('http')) {
        try {
          specUrl = new URL(specUrl, baseUrl).href;
        } catch {
          continue;
        }
      }
      if (!urls.includes(specUrl)) {
        urls.push(specUrl);
      }
    }
  }
  return urls;
};

// Generate common API endpoints when direct access fails
const generateCommonAPIEndpoints = (documentationUrl: string): Endpoint[] => {
  const urlObj = new URL(documentationUrl);
  const domain = urlObj.hostname;
  const apiName = domain.split('.')[0];
  const commonEndpoints: Endpoint[] = [
    { path: '/users', method: 'GET', operationId: 'getUsers', description: 'Get all users', tags: ['users'], parameters: [] },
    { path: '/users', method: 'POST', operationId: 'createUser', description: 'Create a new user', tags: ['users'], parameters: [] },
    { path: '/users/{id}', method: 'GET', operationId: 'getUserById', description: 'Get user by ID', tags: ['users'], parameters: [{ name: 'id', in: 'path', type: 'string', required: true }] as any },
    { path: '/api/v1/data', method: 'GET', operationId: 'getData', description: 'Get data', tags: ['data'], parameters: [] },
    { path: '/health', method: 'GET', operationId: 'healthCheck', description: 'Health check', tags: ['system'], parameters: [] }
  ] as Endpoint[];
  console.log(`[McpBuilder] Generated ${commonEndpoints.length} common endpoints for ${apiName}`);
  return commonEndpoints;
};

// Parse Postman Collection
const parsePostmanCollection = (collection: any): Endpoint[] => {
  const endpoints: Endpoint[] = [];
  const processItem = (item: any, parentPath = '') => {
    if (item.item) {
      item.item.forEach((subItem: any) => {
        processItem(subItem, parentPath);
      });
    } else if (item.request) {
      const request = item.request;
      const method = request.method || 'GET';
      let path = '';
      if (typeof request.url === 'string') {
        try {
          path = new URL(request.url).pathname;
        } catch {
          path = request.url;
        }
      } else if (request.url && request.url.path) {
        path = '/' + request.url.path.join('/');
      }
      if (path && path !== '/') {
        const endpoint: Endpoint = {
          path,
          method: method.toUpperCase(),
          operationId: generateOperationId(method, path),
          description: item.name || `${method} ${path}`,
          parameters: extractParametersFromPostmanRequest(request),
          tags: [parentPath || 'general']
        } as Endpoint;
        endpoints.push(endpoint);
      }
    }
  };
  if (collection.item) {
    collection.item.forEach((item: any) => processItem(item));
  }
  return endpoints;
};

// Extract parameters from Postman request
const extractParametersFromPostmanRequest = (request: any): any[] => {
  const parameters: any[] = [];
  if (request.url && request.url.query) {
    request.url.query.forEach((param: any) => {
      parameters.push({
        name: param.key,
        in: 'query',
        type: 'string',
        required: !param.disabled,
        description: param.description || ''
      });
    });
  }
  if (request.header) {
    request.header.forEach((header: any) => {
      if (!header.key.toLowerCase().includes('authorization')) {
        parameters.push({
          name: header.key,
          in: 'header',
          type: 'string',
          required: !header.disabled,
          description: header.description || ''
        });
      }
    });
  }
  return parameters;
};

// Extract endpoints from generic JSON content
const extractEndpointsFromGenericJSON = (jsonContent: any): Endpoint[] => {
  const endpoints: Endpoint[] = [];
  const searchForEndpoints = (obj: any, path = '') => {
    if (typeof obj === 'string') {
      if (obj.match(/^\/[a-zA-Z0-9\-_\/{}]*$/)) {
        endpoints.push({
          path: obj,
          method: 'GET',
          operationId: generateOperationId('GET', obj),
          description: `Endpoint found in JSON: ${obj}`,
          parameters: extractParametersFromPath(obj),
          tags: ['json-extracted']
        } as Endpoint);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => searchForEndpoints(item, `${path}[${index}]`));
    } else if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(key => {
        searchForEndpoints(obj[key], path ? `${path}.${key}` : key);
      });
    }
  };
  searchForEndpoints(jsonContent);
  return endpoints;
};

// Crawl documentation across multiple pages using LLM-assisted link discovery
const crawlDocumentation = async (startUrl: string, apiKey: string, maxDepth: number): Promise<CrawlResult> => {
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const endpoints: Endpoint[] = [];
  const existingKeys = new Set<string>();
  const sourceUrls: string[] = [];
  const detectedSpecs: string[] = [];
  let baseUrl = '';
  let firstHtml = '';

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);
    console.log(`[McpBuilder] Crawling ${url} (depth ${depth})`);

    const html = await fetchPageWithStrategies(url);
    if (!html) continue;
    if (!firstHtml) firstHtml = html;
    sourceUrls.push(url);

    // Try to detect and parse OpenAPI/Swagger specs on this page
    const specUrls = await findSpecUrls(html, url);
    for (const specUrl of specUrls) {
      try {
        const specHtml = await fetchPageWithStrategies(specUrl);
        if (specHtml && specHtml.length > 50) {
          const parsedEndpoints = await parseOpenAPISpec(specHtml, specUrl);
          for (const ep of parsedEndpoints) {
            const key = `${ep.method}:${ep.path}`;
            if (!existingKeys.has(key)) {
              endpoints.push(ep);
              existingKeys.add(key);
            }
          }
          detectedSpecs.push('Swagger/OpenAPI Documentation');
          sourceUrls.push(specUrl);
        }
      } catch (err) {
        console.warn('[McpBuilder] Failed to parse spec at', specUrl, err);
      }
    }

    // Parse HTML endpoints
    const htmlEndpoints = await parseHTMLDocumentation(html, url);
    for (const ep of htmlEndpoints) {
      const key = `${ep.method}:${ep.path}`;
      if (!existingKeys.has(key)) {
        endpoints.push(ep);
        existingKeys.add(key);
      }
    }

    // Link discovery for further crawl
    const linkCandidates = extractLinksFromHtml(html, url);
    let llmLinks: string[] = [];
    if (apiKey) {
      try { llmLinks = await llmSuggestLinks(html, url, apiKey); } catch { llmLinks = []; }
    }
    const nextLinks = Array.from(new Set([...linkCandidates, ...llmLinks]))
      .filter(u => !visited.has(u))
      .slice(0, 20);
    nextLinks.forEach(u => queue.push({ url: u, depth: depth + 1 }));
  }

  baseUrl = firstHtml ? extractBaseUrl(firstHtml, startUrl) : new URL(startUrl).origin + '/api';
  return {
    endpoints,
    baseUrl,
    authType: detectAuthType(firstHtml || ''),
    sourceUrls: Array.from(new Set(sourceUrls)),
    detectedSpecs: Array.from(new Set(detectedSpecs.length ? detectedSpecs : ['HTML Documentation Parsing']))
  };
};

// Process URL with LLM-assisted crawl
const processUrlWithLLMCrawl = async (url: string, apiKey: string, maxDepth: number): Promise<CrawlResult> => {
  if (!url.startsWith('https://')) {
    throw new Error('Only HTTPS URLs are allowed');
  }
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    throw new Error('Local URLs are not allowed for security reasons');
  }
  return await crawlDocumentation(url, apiKey, Math.max(0, Math.min(maxDepth, 4)));
};

// Process content from different input methods
const processContent = async (method: 'url' | 'paste' | 'upload', url: string, content: string, file: File | null): Promise<CrawlResult> => {
  console.log(`[McpBuilder] Processing content using method: ${method}`);
  let contentToProcess = '';
  let sourceUrl = url || 'manual-input';
  switch (method) {
    case 'url':
      return await realCrawl(url, {});
    case 'paste':
      contentToProcess = content;
      console.log(`[McpBuilder] Processing pasted content, length: ${content.length}`);
      break;
    case 'upload':
      if (!file) throw new Error('No file uploaded');
      console.log(`[McpBuilder] Processing uploaded file: ${file.name}`);
      const fileContent = await file.text();
      contentToProcess = fileContent;
      sourceUrl = file.name;
      break;
    default:
      throw new Error('Invalid input method');
  }
  const endpoints: Endpoint[] = [];
  const detectedSpecs: string[] = [];
  try {
    const jsonContent = JSON.parse(contentToProcess);
    console.log('[McpBuilder] Content detected as JSON');
    if (jsonContent.swagger || jsonContent.openapi || jsonContent.paths) {
      console.log('[McpBuilder] JSON content detected as OpenAPI/Swagger spec');
      detectedSpecs.push('OpenAPI/Swagger JSON Spec');
      const specEndpoints = await parseOpenAPISpec(contentToProcess, sourceUrl);
      endpoints.push(...specEndpoints);
    } else if (jsonContent.item && jsonContent.info) {
      console.log('[McpBuilder] JSON content detected as Postman Collection');
      detectedSpecs.push('Postman Collection');
      const postmanEndpoints = parsePostmanCollection(jsonContent);
      endpoints.push(...postmanEndpoints);
    } else {
      console.log('[McpBuilder] Generic JSON detected, attempting endpoint extraction');
      detectedSpecs.push('Generic JSON Content');
      const jsonEndpoints = extractEndpointsFromGenericJSON(jsonContent);
      endpoints.push(...jsonEndpoints);
    }
  } catch {
    try {
      const yamlContent = parseYAMLContent(contentToProcess);
      if (yamlContent && (yamlContent.swagger || yamlContent.openapi || yamlContent.paths)) {
        console.log('[McpBuilder] Content detected as YAML OpenAPI spec');
        detectedSpecs.push('OpenAPI/Swagger YAML Spec');
        const specEndpoints = await parseOpenAPISpec(contentToProcess, sourceUrl);
        endpoints.push(...specEndpoints);
      } else {
        throw new Error('Not a valid YAML OpenAPI spec');
      }
    } catch {
      console.log('[McpBuilder] Content detected as HTML/Text, performing comprehensive parsing');
      detectedSpecs.push('HTML/Text Content Parsing');
      const htmlEndpoints = await parseHTMLDocumentation(contentToProcess, sourceUrl);
      endpoints.push(...htmlEndpoints);
    }
  }
  let baseUrl = '';
  if (method === 'url') {
    baseUrl = extractBaseUrl(contentToProcess, url);
  } else {
    const baseUrlMatch = contentToProcess.match(/(?:baseUrl|host|server)['":\s]*['"]([^'"]+)['"]/i);
    if (baseUrlMatch) {
      baseUrl = baseUrlMatch[1];
    } else {
      baseUrl = 'https://api.example.com';
    }
  }
  console.log(`[McpBuilder] Content processing completed: found ${endpoints.length} endpoints`);
  return {
    endpoints,
    baseUrl,
    authType: detectAuthType(contentToProcess),
    sourceUrls: [sourceUrl],
    detectedSpecs
  };
};

// MCP Generator
const generateMcp = async (crawlResult: CrawlResult, apiKey: string): Promise<McpSpec> => {
  console.log('[McpGenerator] Starting MCP generation');
  const tools: McpTool[] = [] as any;
  for (const endpoint of crawlResult.endpoints) {
    let description = endpoint.description || '';
    try {
      description = await mockOpenAICall(
        `Generate a brief description for API endpoint ${endpoint.method} ${endpoint.path}`,
        apiKey
      );
    } catch (error) {
      console.warn('[McpGenerator] Failed to enhance description:', error);
    }
    const inputSchema: any = {
      type: 'object',
      properties: {}
    };
    if (endpoint.parameters) {
      endpoint.parameters.forEach((param: any) => {
        inputSchema.properties[param.name] = {
          type: (param as any).type || 'string',
          description: (param as any).description || ''
        };
      });
    }
    if ((endpoint as any).requestBody) {
      const schema = (endpoint as any).requestBody?.content?.['application/json']?.schema || (endpoint as any).requestBody?.schema;
      if (schema) {
        Object.assign(inputSchema.properties, (schema as any).properties || {});
      }
    }
    const tool: McpTool = {
      name: endpoint.operationId || `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[^a-zA-Z0-9]/g, '')}`,
      description,
      method: endpoint.method,
      path: endpoint.path,
      input_schema: inputSchema,
      output_schema: {
        type: 'object',
        properties: {
          data: { type: 'object' },
          message: { type: 'string' }
        }
      },
      examples: [
        {
          curl: `curl -H 'Authorization: Bearer \${N8N_CREDENTIALS_TOKEN}' '${crawlResult.baseUrl}${endpoint.path}'`
        }
      ]
    } as any;
    tools.push(tool);
  }
  const mcpSpec: McpSpec = {
    name: new URL(crawlResult.sourceUrls[0]).hostname.replace(/\./g, '-'),
    version: '1.0.0',
    description: 'MCP gerado automaticamente a partir da documentação da API',
    server: {
      base_url: crawlResult.baseUrl,
      auth: {
        type: crawlResult.authType || 'bearer',
        header: 'Authorization',
        prefix: 'Bearer '
      },
      rate_limit: {
        requests_per_minute: 60
      }
    },
    tools,
    metadata: {
      generated_at: new Date().toISOString(),
      source_urls: crawlResult.sourceUrls
    },
    n8n: {
      import_hint: 'Importar como credencial/config asset e referenciar em nodes HTTP Request.',
      env_placeholders: ['N8N_CREDENTIALS_TOKEN', 'N8N_BASE_URL']
    }
  } as McpSpec;
  console.log('[McpGenerator] MCP generation completed');
  return mcpSpec;
};

export default function McpBuilder() {
  const [openaiKey, setOpenaiKey] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mcpSpec, setMcpSpec] = useState<McpSpec | null>(null);
  const [crawlResult, setCrawlResult] = useState<CrawlResult | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [crawlDepth, setCrawlDepth] = useState(2);
  const [respectRobots, setRespectRobots] = useState(true);
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [crawlLogs, setCrawlLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [inputMethod, setInputMethod] = useState<'url' | 'paste' | 'upload'>('url');
  const [pastedContent, setPastedContent] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  const validateOpenAIKey = useCallback(async (key: string): Promise<boolean> => {
    if (!key.startsWith('sk-')) {
      return false;
    }
    try {
      await mockOpenAICall('test', key);
      return true;
    } catch {
      return false;
    }
  }, []);

  const validateUrl = useCallback((url: string): boolean => {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }, []);

  const handleGenerate = async () => {
    setError('');
    setLoading(true);
    setCrawlLogs([]);
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      const message = args.join(' ');
      if (message.includes('[McpBuilder]') || message.includes('[McpGenerator]')) {
        setCrawlLogs(prev => [...prev, message]);
      }
      (originalLog as any)(...args);
    };
    try {
      if (!openaiKey) {
        throw new Error('OpenAI API Key é obrigatória');
      }
      if (inputMethod === 'url' && !docUrl) {
        throw new Error('URL da Documentação é obrigatória');
      }
      if (inputMethod === 'paste' && !pastedContent.trim()) {
        throw new Error('Conteúdo colado é obrigatório');
      }
      if (inputMethod === 'upload' && !uploadedFile) {
        throw new Error('Arquivo é obrigatório');
      }
      if (inputMethod === 'url' && !validateUrl(docUrl)) {
        throw new Error('URL inválida. Use apenas URLs HTTPS válidas');
      }
      const isValidKey = await validateOpenAIKey(openaiKey);
      if (!isValidKey) {
        throw new Error('API Key OpenAI inválida ou sem permissões adequadas');
      }
      console.log(`[McpBuilder] Starting process with method: ${inputMethod}`);
      let result: CrawlResult;
      if (inputMethod === 'url') {
        result = await processUrlWithLLMCrawl(docUrl, openaiKey, crawlDepth);
      } else {
        result = await processContent(inputMethod, docUrl, pastedContent, uploadedFile);
      }
      setCrawlResult(result);
      if (result.endpoints.length === 0) {
        console.warn('[McpBuilder] Resultado sem endpoints. Usando fallback de endpoints comuns.');
      }
      // Ensure mutating endpoints have request body before generating MCP
      const missingBodies = result.endpoints.filter(e => ['POST', 'PUT', 'PATCH'].includes(e.method) && !(e as any).requestBody);
      if (missingBodies.length > 0) {
        throw new Error(`Foram encontrados ${missingBodies.length} endpoints (POST/PUT/PATCH) sem payload de requisição detectado. Aumente a profundidade ou forneça a spec (swagger/openapi) via URL/Upload/Colar para continuar.`);
      }
      console.log(`[McpBuilder] Process completed successfully! Found ${result.endpoints.length} endpoints`);
      const mcp = await generateMcp(result, openaiKey);
      setMcpSpec(mcp);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Erro inesperado');
      console.error('[McpBuilder] Error:', err);
    } finally {
      console.log = originalLog;
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!mcpSpec) return;
    const blob = new Blob([JSON.stringify(mcpSpec, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mcpSpec.name}-mcp.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setMcpSpec(null);
    setCrawlResult(null);
    setError('');
  };

  const filteredEndpoints = crawlResult?.endpoints.filter(endpoint => {
    const methodMatch = methodFilter === 'all' || endpoint.method === methodFilter;
    const tagMatch = tagFilter === 'all' || (endpoint.tags && endpoint.tags.includes(tagFilter));
    return methodMatch && tagMatch;
  }) || [];

  const uniqueTags = Array.from(new Set(
    crawlResult?.endpoints.flatMap(e => e.tags || []) || []
  ));

  const getMethodColor = (method: string) => {
    const colors: any = {
      GET: 'bg-green-100 text-green-800',
      POST: 'bg-blue-100 text-blue-800',
      PUT: 'bg-yellow-100 text-yellow-800',
      DELETE: 'bg-red-100 text-red-800',
      PATCH: 'bg-purple-100 text-purple-800'
    };
    return colors[method] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50/30 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-4">
            Gerador MCP para n8n
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto mb-6">
            Converta automaticamente documentações de API em arquivos MCP (Model Context Protocol) 
            prontos para usar no n8n
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 max-w-3xl mx-auto">
            <h3 className="font-semibold text-blue-800 mb-2">💡 Problemas com CORS?</h3>
            <p className="text-sm text-blue-700 mb-3">
              Se a URL der erro de CORS, use uma dessas alternativas:
            </p>
            <div className="grid md:grid-cols-3 gap-3 text-sm">
              <div className="bg-white rounded-lg p-3">
                <strong className="text-blue-800">📋 Colar Conteúdo</strong>
                <p className="text-gray-600 mt-1">Copie o HTML da página ou JSON do Swagger e cole diretamente</p>
              </div>
              <div className="bg-white rounded-lg p-3">
                <strong className="text-blue-800">📄 Upload Arquivo</strong>
                <p className="text-gray-600 mt-1">Faça download do swagger.json e faça upload aqui</p>
              </div>
              <div className="bg-white rounded-lg p-3">
                <strong className="text-blue-800">🔗 URL Direta</strong>
                <p className="text-gray-600 mt-1">Use URLs diretas como /swagger.json ou /openapi.yaml</p>
              </div>
            </div>
          </div>
        </div>
        <div className="grid lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-6 shadow-xl border border-white/20">
              <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-600" />
                Configuração
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    Método de Input
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setInputMethod('url')}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        inputMethod === 'url' 
                          ? 'bg-blue-100 text-blue-700 border border-blue-300' 
                          : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-150'
                      }`}
                    >
                      URL
                    </button>
                    <button
                      type="button"
                      onClick={() => setInputMethod('paste')}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        inputMethod === 'paste' 
                          ? 'bg-blue-100 text-blue-700 border border-blue-300' 
                          : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-150'
                      }`}
                    >
                      Colar Conteúdo
                    </button>
                    <button
                      type="button"
                      onClick={() => setInputMethod('upload')}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        inputMethod === 'upload' 
                          ? 'bg-blue-100 text-blue-700 border border-blue-300' 
                          : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-150'
                      }`}
                    >
                      Upload Arquivo
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <Key className="w-4 h-4 inline mr-2" />
                    OpenAI API Key *
                  </label>
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                    disabled={loading}
                  />
                </div>
                {inputMethod === 'url' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      <Globe className="w-4 h-4 inline mr-2" />
                      URL da Documentação *
                    </label>
                    <input
                      type="url"
                      value={docUrl}
                      onChange={(e) => setDocUrl(e.target.value)}
                      placeholder="https://docs.api.com"
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      disabled={loading}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Caso der erro de CORS, use um dos métodos alternativos abaixo
                    </p>
                  </div>
                )}
                {inputMethod === 'paste' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Conteúdo da Documentação *
                    </label>
                    <textarea
                      value={pastedContent}
                      onChange={(e) => setPastedContent(e.target.value)}
                      placeholder="Cole aqui o HTML da documentação, JSON do Swagger, ou qualquer conteúdo da API..."
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      rows={8}
                      disabled={loading}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Cole o código fonte da página, OpenAPI spec, ou qualquer conteúdo relevante
                    </p>
                  </div>
                )}
                {inputMethod === 'upload' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Upload de Arquivo
                    </label>
                    <div className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center hover:border-blue-400 transition-colors">
                      <input
                        type="file"
                        onChange={(e) => setUploadedFile(e.target.files?.[0] || null)}
                        accept=".json,.yaml,.yml,.html,.txt,.md"
                        className="hidden"
                        id="fileUpload"
                        disabled={loading}
                      />
                      <label htmlFor="fileUpload" className="cursor-pointer">
                        <div className="space-y-2">
                          <div className="mx-auto w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center">
                            📄
                          </div>
                          <p className="text-sm text-gray-600">
                            {uploadedFile ? uploadedFile.name : 'Clique para selecionar arquivo'}
                          </p>
                          <p className="text-xs text-gray-500">
                            JSON, YAML, HTML, TXT, MD
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                )}
                <button
                  onClick={handleGenerate}
                  disabled={loading || !openaiKey || (!docUrl && !pastedContent && !uploadedFile)}
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-3 px-6 rounded-xl font-semibold hover:from-blue-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Gerando MCP...
                    </>
                  ) : (
                    'Gerar MCP JSON'
                  )}
                </button>
              </div>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-red-800">Erro</h3>
                  <p className="text-red-700 text-sm">{error}</p>
                  <button
                    onClick={handleGenerate}
                    className="mt-2 text-sm text-red-600 hover:text-red-700 underline"
                    disabled={loading}
                  >
                    Tentar novamente
                  </button>
                </div>
              </div>
            )}
            {mcpSpec && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-green-500 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="font-semibold text-green-800">MCP Gerado com Sucesso!</h3>
                    <p className="text-green-700 text-sm">
                      {mcpSpec.tools.length} ferramentas foram criadas a partir de {crawlResult?.detectedSpecs.join(', ')}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Baixar MCP.json
                  </button>
                  <button
                    onClick={handleReset}
                    className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Gerar Novo
                  </button>
                  <button
                    onClick={() => setShowLogs(!showLogs)}
                    className="px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors"
                  >
                    {showLogs ? 'Ocultar' : 'Ver'} Logs
                  </button>
                </div>
              </div>
            )}
            {(crawlLogs.length > 0 || loading) && showLogs && (
              <div className="bg-gray-900 text-green-400 rounded-xl p-4 font-mono text-sm max-h-96 overflow-y-auto">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white font-semibold">Logs do Processo</h3>
                  <button
                    onClick={() => setCrawlLogs([])}
                    className="text-gray-400 hover:text-white transition-colors"
                  >
                    Limpar
                  </button>
                </div>
                <div className="space-y-1">
                  {crawlLogs.map((log, index) => (
                    <div key={index} className="text-xs">
                      {log}
                    </div>
                  ))}
                  {loading && (
                    <div className="text-yellow-400 text-xs">
                      <Loader2 className="w-3 h-3 animate-spin inline mr-2" />
                      Processando...
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-6">
            {crawlResult && (
              <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-6 shadow-xl border border-white/20">
                <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                  <Eye className="w-5 h-5 text-blue-600" />
                  Endpoints Descobertos ({filteredEndpoints.length})
                </h2>
                <div className="flex gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      <Filter className="w-4 h-4 inline mr-1" />
                      Método
                    </label>
                    <select
                      value={methodFilter}
                      onChange={(e) => setMethodFilter(e.target.value)}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="all">Todos</option>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                      <option value="PATCH">PATCH</option>
                    </select>
                  </div>
                  {uniqueTags.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tag</label>
                      <select
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="all">Todas</option>
                        {uniqueTags.map(tag => (
                          <option key={tag} value={tag}>{tag}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {filteredEndpoints.map((endpoint, index) => (
                    <div key={index} className="p-4 bg-white rounded-xl border border-gray-100 hover:border-blue-200 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-1 rounded-md text-xs font-semibold ${getMethodColor(endpoint.method)}`}>
                            {endpoint.method}
                          </span>
                          <code className="text-sm text-gray-700 font-mono">{endpoint.path}</code>
                        </div>
                        {endpoint.tags && (
                          <div className="flex gap-1">
                            {endpoint.tags.map(tag => (
                              <span key={tag} className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-md">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {endpoint.description && (
                        <p className="text-sm text-gray-600">{endpoint.description}</p>
                      )}
                      {(endpoint.parameters && (endpoint as any).parameters.length > 0) && (
                        <div className="mt-2">
                          <p className="text-xs text-gray-500 mb-1">Parâmetros:</p>
                          <div className="flex flex-wrap gap-1">
                            {(endpoint as any).parameters.slice(0, 3).map((param: any, idx: number) => (
                              <span key={idx} className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">
                                {param.name} ({param.type || 'string'})
                              </span>
                            ))}
                            {(endpoint as any).parameters.length > 3 && (
                              <span className="text-xs text-gray-500">+{(endpoint as any).parameters.length - 3} mais</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {filteredEndpoints.length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    <Filter className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>Nenhum endpoint encontrado com os filtros aplicados</p>
                  </div>
                )}
              </div>
            )}
            {mcpSpec && (
              <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-6 shadow-xl border border-white/20">
                <h2 className="text-xl font-semibold mb-6">MCP Gerado</h2>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-600">Nome:</span>
                      <p className="font-semibold">{mcpSpec.name}</p>
                    </div>
                    <div>
                      <span className="text-gray-600">Versão:</span>
                      <p className="font-semibold">{mcpSpec.version}</p>
                    </div>
                    <div>
                      <span className="text-gray-600">Base URL:</span>
                      <p className="font-semibold truncate">{mcpSpec.server.base_url}</p>
                    </div>
                    <div>
                      <span className="text-gray-600">Ferramentas:</span>
                      <p className="font-semibold">{mcpSpec.tools.length}</p>
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold mb-2">Ferramentas MCP:</h3>
                    <div className="space-y-2">
                      {mcpSpec.tools.slice(0, 5).map((tool, index) => (
                        <div key={index} className="flex items-center justify-between text-sm">
                          <span className="font-mono text-blue-600">{tool.name}</span>
                          <span className="text-gray-500">{tool.method} {tool.path}</span>
                        </div>
                      ))}
                      {mcpSpec.tools.length > 5 && (
                        <p className="text-sm text-gray-500 text-center">+{mcpSpec.tools.length - 5} ferramentas adicionais</p>
                      )}
                    </div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-blue-800 mb-2">Instrução para n8n:</h3>
                    <p className="text-sm text-blue-700">{mcpSpec.n8n.import_hint}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}