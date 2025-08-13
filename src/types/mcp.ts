export interface Endpoint {
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

export interface ApiSpec {
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

export interface McpTool {
  name: string;
  description: string;
  method: string;
  path: string;
  query?: Record<string, any>;
  headers?: Record<string, any>;
  input_schema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  output_schema?: {
    type: string;
    properties: Record<string, any>;
  };
  examples?: Array<{
    curl?: string;
    description?: string;
  }>;
}

export interface McpSpec {
  name: string;
  version: string;
  description: string;
  server: {
    base_url: string;
    auth?: {
      type: string;
      header?: string;
      prefix?: string;
    };
    rate_limit?: {
      requests_per_minute: number;
    };
  };
  tools: McpTool[];
  metadata: {
    generated_at: string;
    source_urls: string[];
  };
  n8n: {
    import_hint: string;
    env_placeholders: string[];
  };
}

export interface GenerateMcpRequest {
  url: string;
  openaiApiKey: string;
  options?: {
    maxPages?: number;
    respectRobots?: boolean;
    allowedDomains?: string[];
    includeWorkflow?: boolean;
  };
}

export interface GenerateMcpResponse {
  success: boolean;
  data?: McpSpec;
  endpoints?: Endpoint[];
  error?: string;
  logs?: string[];
}