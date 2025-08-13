import { useRef } from 'react';
import { HeroSection } from '@/components/HeroSection';
import { McpForm } from '@/components/McpForm';
import { useMcpGenerator } from '@/hooks/use-mcp-generator';

const Index = () => {
  const formRef = useRef<HTMLDivElement>(null);
  const { generateMcp } = useMcpGenerator();

  const scrollToForm = () => {
    formRef.current?.scrollIntoView({ 
      behavior: 'smooth',
      block: 'start'
    });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-background/80 backdrop-blur-md sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-sm">M</span>
              </div>
              <span className="text-xl font-bold">MCP Generator</span>
            </div>
            <nav className="hidden md:flex items-center gap-6">
              <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">
                Recursos
              </a>
              <a href="#generator" className="text-muted-foreground hover:text-foreground transition-colors">
                Gerador
              </a>
            </nav>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section id="hero">
        <HeroSection onGetStarted={scrollToForm} />
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 px-4">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Como Funciona
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Processo simples e automático para gerar MCPs profissionais
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto">
                <span className="text-2xl font-bold text-primary-foreground">1</span>
              </div>
              <h3 className="text-xl font-semibold">Insira a URL</h3>
              <p className="text-muted-foreground">
                Cole a URL da documentação da sua API e sua OpenAI API key
              </p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto">
                <span className="text-2xl font-bold text-primary-foreground">2</span>
              </div>
              <h3 className="text-xl font-semibold">Processamento IA</h3>
              <p className="text-muted-foreground">
                Nosso sistema faz crawl inteligente e melhora as descrições com OpenAI
              </p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto">
                <span className="text-2xl font-bold text-primary-foreground">3</span>
              </div>
              <h3 className="text-xl font-semibold">Download MCP</h3>
              <p className="text-muted-foreground">
                Baixe o arquivo JSON pronto para importar no n8n
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Generator Section */}
      <section id="generator" className="py-24 px-4 bg-secondary/20">
        <div className="container mx-auto max-w-4xl" ref={formRef}>
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Gerador de MCP
            </h2>
            <p className="text-xl text-muted-foreground">
              Transforme sua documentação de API em MCP agora
            </p>
          </div>

          <McpForm onGenerate={generateMcp} />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50 py-12 px-4">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center gap-2">
              <div className="w-6 h-6 bg-gradient-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-xs">M</span>
              </div>
              <span className="text-lg font-bold">MCP Generator</span>
            </div>
            <p className="text-muted-foreground">
              Powered by OpenAI • Built with Lovable
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;