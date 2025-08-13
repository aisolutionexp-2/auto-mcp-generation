import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { GenerateMcpRequest, GenerateMcpResponse } from '@/types/mcp';

export const useMcpGenerator = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateMcp = async (request: GenerateMcpRequest): Promise<GenerateMcpResponse> => {
    setIsLoading(true);
    setError(null);

    try {
      console.log('[useMcpGenerator] Calling Supabase function');
      
      const { data, error: functionError } = await supabase.functions.invoke('generate-mcp', {
        body: request,
      });

      if (functionError) {
        console.error('[useMcpGenerator] Function error:', functionError);
        throw new Error(functionError.message || 'Erro na função do servidor');
      }

      if (!data) {
        throw new Error('Resposta vazia do servidor');
      }

      console.log('[useMcpGenerator] Success:', data);
      return data;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erro desconhecido';
      console.error('[useMcpGenerator] Error:', errorMessage);
      setError(errorMessage);
      
      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      setIsLoading(false);
    }
  };

  return {
    generateMcp,
    isLoading,
    error,
  };
};