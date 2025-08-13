import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, Loader2, Download, AlertCircle, CheckCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import type { GenerateMcpRequest, GenerateMcpResponse, Endpoint } from '@/types/mcp';

interface McpFormProps {
  onGenerate: (request: GenerateMcpRequest) => Promise<GenerateMcpResponse>;
}

export const McpForm = ({ onGenerate }: McpFormProps) => {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [maxPages, setMaxPages] = useState(50);
  const [respectRobots, setRespectRobots] = useState(true);
  const [allowedDomains, setAllowedDomains] = useState('');
  const [includeWorkflow, setIncludeWorkflow] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<GenerateMcpResponse | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(new Set(['GET', 'POST', 'PUT', 'DELETE']));

  const validateInputs = () => {
    if (!url.trim()) {
      toast({
        title: "URL obrigatória",
        description: "Por favor, insira a URL da documentação da API",
        variant: "destructive",
      });
      return false;
    }

    try {
      new URL(url);
    } catch {
      toast({
        title: "URL inválida",
        description: "Por favor, insira uma URL válida",
        variant: "destructive",
      });
      return false;
    }

    if (!apiKey.trim() || !apiKey.startsWith('sk-')) {
      toast({
        title: "API Key inválida",
        description: "Por favor, insira uma API Key válida da OpenAI (deve começar com 'sk-')",
        variant: "destructive",
      });
      return false;
    }

    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateInputs()) return;

    setIsLoading(true);
    setResult(null);
    setEndpoints([]);

    try {
      console.log('[McpForm] Starting MCP generation');
      
      const request: GenerateMcpRequest = {
        url: url.trim(),
        openaiApiKey: apiKey.trim(),
        options: {
          maxPages,
          respectRobots,
          allowedDomains: allowedDomains.split(',').map(d => d.trim()).filter(d => d),
          includeWorkflow,
        },
      };

      const response = await onGenerate(request);
      
      setResult(response);
      if (response.endpoints) {
        setEndpoints(response.endpoints);
      }

      if (response.success) {
        toast({
          title: "MCP gerado com sucesso!",
          description: `Foram encontrados ${response.endpoints?.length || 0} endpoints`,
        });
      } else {
        toast({
          title: "Erro na geração",
          description: response.error || "Falha ao gerar MCP",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('[McpForm] Error:', error);
      toast({
        title: "Erro",
        description: "Falha na comunicação com o servidor",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const downloadMcp = () => {
    if (!result?.data) return;

    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: 'application/json',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.data.name}-mcp.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: "Download iniciado",
      description: "O arquivo MCP.json foi baixado com sucesso",
    });
  };

  const filteredEndpoints = endpoints.filter(endpoint => 
    selectedMethods.has(endpoint.method.toUpperCase())
  );

  const toggleMethod = (method: string) => {
    const newMethods = new Set(selectedMethods);
    if (newMethods.has(method)) {
      newMethods.delete(method);
    } else {
      newMethods.add(method);
    }
    setSelectedMethods(newMethods);
  };

  return (
    <div className="space-y-6">
      <Card className="bg-card/50 backdrop-blur-sm border-border/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">M</span>
            </div>
            Gerador de MCP
          </CardTitle>
          <CardDescription>
            Gere Model Context Protocol a partir de documentação de APIs usando IA
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="openai-key">OpenAI API Key *</Label>
              <div className="relative">
                <Input
                  id="openai-key"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="pr-10"
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-url">URL da Documentação da API *</Label>
              <Input
                id="api-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.example.com/api"
                required
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="max-pages">Limite de Páginas para Crawling</Label>
                <Input
                  id="max-pages"
                  type="number"
                  min="1"
                  max="200"
                  value={maxPages}
                  onChange={(e) => setMaxPages(parseInt(e.target.value) || 50)}
                />
                <p className="text-xs text-muted-foreground">
                  Máximo de páginas a processar (1-200). Mais páginas = mais endpoints, mas processamento mais lento.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="respect-robots"
                    checked={respectRobots}
                    onCheckedChange={setRespectRobots}
                  />
                  <Label htmlFor="respect-robots">Respeitar robots.txt</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Switch
                    id="include-workflow"
                    checked={includeWorkflow}
                    onCheckedChange={setIncludeWorkflow}
                  />
                  <Label htmlFor="include-workflow">Incluir exemplo n8n</Label>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="allowed-domains">Domínios Permitidos (opcional)</Label>
              <Textarea
                id="allowed-domains"
                value={allowedDomains}
                onChange={(e) => setAllowedDomains(e.target.value)}
                placeholder="example.com, api.example.com"
                rows={2}
              />
            </div>

            <Button
              type="submit"
              variant="gradient"
              size="lg"
              disabled={isLoading}
              className="w-full"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Gerando MCP...
                </>
              ) : (
                'Gerar MCP'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                {result.success ? (
                  <CheckCircle className="h-5 w-5 text-primary" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-destructive" />
                )}
                Resultado
              </span>
              {result.success && result.data && (
                <Button onClick={downloadMcp} variant="outline" size="sm">
                  <Download className="h-4 w-4" />
                  Baixar MCP.json
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {result.success ? (
              <div className="space-y-4">
                <Alert>
                  <CheckCircle className="h-4 w-4" />
                  <AlertDescription>
                    MCP gerado com sucesso! Encontrados {endpoints.length} endpoints.
                  </AlertDescription>
                </Alert>

                {endpoints.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      <Label className="text-sm font-medium">Filtrar por método:</Label>
                      {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(method => (
                        <Badge
                          key={method}
                          variant={selectedMethods.has(method) ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => toggleMethod(method)}
                        >
                          {method}
                        </Badge>
                      ))}
                    </div>

                    <div className="max-h-64 overflow-y-auto space-y-2">
                      {filteredEndpoints.map((endpoint, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/30"
                        >
                          <div className="flex items-center gap-3">
                            <Badge variant={
                              endpoint.method === 'GET' ? 'secondary' :
                              endpoint.method === 'POST' ? 'default' :
                              endpoint.method === 'PUT' ? 'outline' : 'destructive'
                            }>
                              {endpoint.method}
                            </Badge>
                            <code className="text-sm bg-muted px-2 py-1 rounded">
                              {endpoint.path}
                            </code>
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {endpoint.summary || endpoint.description || 'Sem descrição'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {result.error || 'Erro desconhecido'}
                </AlertDescription>
              </Alert>
            )}

            {result.logs && result.logs.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Ver logs de processamento
                </summary>
                <pre className="mt-2 text-xs bg-muted p-3 rounded overflow-auto max-h-32">
                  {result.logs.join('\n')}
                </pre>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};