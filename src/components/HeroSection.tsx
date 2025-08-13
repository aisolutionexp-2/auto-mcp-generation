import { Button } from '@/components/ui/button';
import { ArrowRight, Zap, Globe, Download } from 'lucide-react';

interface HeroSectionProps {
  onGetStarted: () => void;
}

export const HeroSection = ({ onGetStarted }: HeroSectionProps) => {
  return (
    <div className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-secondary opacity-50" />
      
      {/* Content */}
      <div className="relative z-10 text-center py-24 px-4">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-glass border border-border/50 backdrop-blur-md">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Powered by OpenAI</span>
          </div>

          {/* Main heading */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold leading-tight">
            Gere{' '}
            <span className="bg-gradient-primary bg-clip-text text-transparent">
              MCP
            </span>{' '}
            automaticamente
          </h1>

          {/* Subtitle */}
          <p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            Transforme qualquer documentação de API em Model Context Protocol 
            pronto para n8n usando inteligência artificial
          </p>

          {/* Features */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto mt-12">
            <div className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-glass border border-border/50 backdrop-blur-md">
              <Globe className="h-8 w-8 text-primary" />
              <h3 className="font-semibold">Crawl Automático</h3>
              <p className="text-sm text-muted-foreground text-center">
                Detecta OpenAPI, Swagger, Postman e mais
              </p>
            </div>

            <div className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-glass border border-border/50 backdrop-blur-md">
              <Zap className="h-8 w-8 text-primary" />
              <h3 className="font-semibold">IA Inteligente</h3>
              <p className="text-sm text-muted-foreground text-center">
                OpenAI melhora descrições e resolve ambiguidades
              </p>
            </div>

            <div className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-glass border border-border/50 backdrop-blur-md">
              <Download className="h-8 w-8 text-primary" />
              <h3 className="font-semibold">Pronto para n8n</h3>
              <p className="text-sm text-muted-foreground text-center">
                JSON compatível com workflows n8n
              </p>
            </div>
          </div>

          {/* CTA Button */}
          <div className="pt-8">
            <Button 
              onClick={onGetStarted}
              variant="gradient" 
              size="lg"
              className="text-lg px-8 py-4 h-auto shadow-glow"
            >
              Começar Agora
              <ArrowRight className="h-5 w-5 ml-2" />
            </Button>
          </div>

          {/* Demo info */}
          <p className="text-sm text-muted-foreground mt-6">
            Precisa apenas de uma URL de documentação e uma API key da OpenAI
          </p>
        </div>
      </div>

      {/* Decorative elements */}
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-accent/10 rounded-full blur-3xl" />
    </div>
  );
};