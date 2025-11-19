# 📋 Checklist de Deploy - Render + Vercel

## ✅ Pré-requisitos

- [ ] Conta no GitHub
- [ ] Conta no Render (https://render.com)
- [ ] Conta no Vercel (https://vercel.com)
- [ ] Chave da API OpenAI (https://platform.openai.com/api-keys)

---

## 🔧 Preparação do Backend (Render)

### 1. Verificar arquivos criados
- [ ] `render.yaml` - Configuração do Render
- [ ] `.env.example` - Exemplo de variáveis de ambiente
- [ ] `README.md` - Documentação atualizada
- [ ] `.gitignore` - Arquivos ignorados configurados

### 2. Configurar variáveis localmente (opcional)
- [ ] Copiar `.env.example` para `.env`
- [ ] Adicionar sua `OPENAI_API_KEY` no `.env`
- [ ] Testar localmente com `npm run dev`

### 3. Commit e Push
```bash
git add .
git commit -m "Preparar backend para deploy no Render"
git push origin main
```
- [ ] Código commitado
- [ ] Push realizado com sucesso

---

## 🚀 Deploy no Render

### 1. Criar Web Service
- [ ] Acessar https://render.com/dashboard
- [ ] Clicar em "New +" → "Web Service"
- [ ] Conectar repositório GitHub
- [ ] Selecionar branch `main`

### 2. Configurar Serviço
- [ ] **Name**: `kiosk-backend` (ou seu nome)
- [ ] **Runtime**: Node
- [ ] **Build Command**: `npm install`
- [ ] **Start Command**: `npm start`
- [ ] **Instance Type**: Free (ou pago)

### 3. Adicionar Variáveis de Ambiente

| Variável | Valor | Status |
|----------|-------|--------|
| `NODE_ENV` | `production` | [ ] |
| `PORT` | `3001` | [ ] |
| `OPENAI_API_KEY` | `sk-...` (sua chave) | [ ] |
| `FRONTEND_URL` | `https://seu-app.vercel.app` | [ ] |

### 4. Deploy
- [ ] Clicar em "Create Web Service"
- [ ] Aguardar build (2-5 minutos)
- [ ] Verificar logs de deploy
- [ ] Copiar URL do backend (ex: `https://kiosk-backend.onrender.com`)

---

## 🌐 Configurar Frontend (Vercel)

### 1. Adicionar Variável de Ambiente no Vercel
- [ ] Acessar projeto no Vercel
- [ ] Ir em "Settings" → "Environment Variables"
- [ ] Adicionar: `NEXT_PUBLIC_API_URL` = `https://kiosk-backend.onrender.com`
- [ ] Salvar e fazer redeploy

### 2. Atualizar FRONTEND_URL no Render
- [ ] Copiar URL do frontend Vercel (ex: `https://seu-app.vercel.app`)
- [ ] Voltar ao Render → Environment
- [ ] Atualizar `FRONTEND_URL` com a URL do Vercel
- [ ] Salvar (trigger redeploy automático)

---

## 🧪 Testes

### Backend (Render)
- [ ] Testar health check: `https://seu-backend.onrender.com/health`
- [ ] Testar API de menu: `https://seu-backend.onrender.com/api/menu`
- [ ] Verificar logs no Render Dashboard

### Frontend (Vercel)
- [ ] Abrir aplicação no Vercel
- [ ] Verificar se carrega os produtos
- [ ] Testar criação de pedido
- [ ] Testar chat com IA

### Integração
- [ ] Verificar no Network (DevTools) se requisições estão indo para URL correta
- [ ] Confirmar que não há erros de CORS
- [ ] Testar fluxo completo: cadastro → pedido → confirmação

---

## 🐛 Troubleshooting

### ❌ Erro de CORS
**Solução:**
1. Verificar se `FRONTEND_URL` no Render está correto
2. Incluir todas as variações da URL Vercel (com e sem www, preview URLs)
3. Exemplo: `https://app.vercel.app,https://app-git-main.vercel.app`

### ❌ IA não responde
**Solução:**
1. Verificar se `OPENAI_API_KEY` está configurada corretamente
2. Confirmar se há créditos na conta OpenAI
3. Checar logs no Render para erros da API

### ❌ Cold start muito lento
**Solução:**
1. Render Free tier tem "sleep" após 15min inatividade
2. Primeira requisição pode levar ~30 segundos
3. Considerar upgrade para plano pago ou usar serviço de ping

### ❌ Dados perdidos após restart
**Solução:**
1. SQLite no Render Free é efêmero
2. Para produção, migrar para PostgreSQL:
   - Render oferece PostgreSQL free
   - Atualizar Knex config no `server.js`

---

## 📝 URLs Importantes

### Backend
- **Dashboard Render**: https://dashboard.render.com
- **URL do Backend**: `https://_________.onrender.com`

### Frontend
- **Dashboard Vercel**: https://vercel.com/dashboard
- **URL do Frontend**: `https://_________.vercel.app`

### Outros
- **OpenAI API Keys**: https://platform.openai.com/api-keys
- **Repositório GitHub**: `https://github.com/________`

---

## ✅ Deploy Concluído!

Quando todos os itens estiverem marcados, seu sistema estará funcionando em produção! 🎉

**Observações finais:**
- Monitorar logs regularmente (especialmente primeiros dias)
- Configurar alertas no Render para downtime
- Documentar mudanças de configuração
- Fazer backups periódicos do banco (se usar PostgreSQL)
