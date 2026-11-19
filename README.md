# Hikari Player 2

Repositório: `pererinhapoo-wq/Hikari-player-2`  
Deploy de Produção: `https://hikari-player-2.vercel.app`

## Arquitetura de Custo Zero para 1.000+ Espectadores Simultâneos

O **Hikari Player 2** foi otimizado para operar no plano Hobby da Vercel (com limite de 100 GB/mês de banda) e banco Neon Free Tier, permitindo atender mil ou mais espectadores simultâneos sem incorrer em custos adicionais.

### Pontos Chave da Arquitetura

1. **Streaming Direto da Origem (Bypassing Vercel Proxy)**:
   - Os segmentos de vídeo (.ts, .mp4, m3u8) das fontes Maximaimg são consumidos diretamente pelo navegador do espectador a partir dos CDNs de origem (`cdn-sv*.maximaimg.online` / R2), desviando totalmente o tráfego de vídeo das funções da Vercel.
   - Isso reduz a banda consumida na Vercel para apenas HTML, JS e metadados de página (~100 KB por visita), permitindo centenas de milhares de visualizações mensais dentro da cota gratuita.

2. **Proxy de Fallback Seguro**:
   - A rota de proxy `/api/proxy/stream` permanece intacta como mecanismo de segurança e fallback automático caso o acesso direto da origem sofra bloqueio de CORS ou restrição de rede no cliente.

3. **Resiliência e Cache**:
   - Cache em memória com política `stale-if-error` para mitigar intermitências no banco Neon.
   - Otimização de imagens com dimensões fixas, WebP e `loading="lazy"` / `srcset`.

---

## Verificação de Caminho de Mídia

Para provar que os segmentos de vídeo e playlists estão sendo carregados diretamente da origem (sem passar por `/api/proxy/stream`), o projeto conta com auditoria automatizada e testes unitários.

### Como Executar o Teste Automatizado de Caminho de Mídia

Você pode verificar o deploy de produção executando o seguinte script ou teste via curl/vitest:

```bash
# Executar a suíte completa de testes de reprodução, proxy e segurança
npm test

# Verificação rápida de URL de mídia em produção (Exemplo com curl e grep)
curl -s https://hikari-player-2.vercel.app/e/SEU_ID_DE_EPISODIO | grep -E "cdn-sv|maximaimg"
```

O teste valida que:
1. As URLs de mídia renderizadas no player apontam diretamente para os hosts de origem (`cdn-sv*.maximaimg.online`).
2. Não há ocorrências de `/api/proxy/stream` nas tags de vídeo em condições normais de acesso direto.
