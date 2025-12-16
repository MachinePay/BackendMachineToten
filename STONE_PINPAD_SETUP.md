# 💳 Stone Pinpad - Guia de Integração

## 📋 Resumo

Este documento explica como usar o novo sistema de pagamentos via **Stone Pinpad** que substitui temporariamente o Mercado Pago.

## 🗂️ Arquivos Criados

### ✅ Novo: `controllers/stonePinpadController.js`

Controller dedicado para pagamentos Stone Pinpad com as seguintes funções:

- `createStonePayment` - Criar pagamento (crédito/débito)
- `cancelStonePayment` - Cancelar transação
- `checkStoneStatus` - Consultar status de transação
- `checkStoneHealth` - Verificar se TEF está online

### 🔒 Preservado: `controllers/paymentController.js`

TODO o código do Mercado Pago está **comentado** mas preservado para uso futuro.

## 🚀 Como Usar

### 1️⃣ Pré-requisitos

1. **Instalar o aplicativo Stone TEF** no computador
2. Manter o aplicativo **rodando** (ele cria o servidor local na porta 6800)
3. Conectar o Pinpad via USB ou Bluetooth

### 2️⃣ Rotas Disponíveis

#### **POST** `/api/payment/stone/create`

Criar um pagamento

**Body:**

```json
{
  "amount": 1000, // Em centavos (1000 = R$ 10,00)
  "type": "CREDIT", // "CREDIT" ou "DEBIT"
  "installments": 1, // Número de parcelas
  "orderId": "order_123" // Opcional: ID do pedido
}
```

**Resposta de Sucesso:**

```json
{
  "success": true,
  "responseCode": "0000",
  "responseMessage": "Aprovado",
  "transactionId": "abc123",
  "authorizationCode": "12345",
  "cardBrand": "Visa",
  "cardNumber": "****1234",
  "orderId": "order_123"
}
```

**Erros Possíveis:**

- **503** - TEF Stone não está disponível (app não está rodando)
- **408** - Timeout (operação demorou muito)
- **400** - Parâmetros inválidos

---

#### **POST** `/api/payment/stone/cancel`

Cancelar uma transação

**Body:**

```json
{
  "transactionId": "abc123"
}
```

---

#### **GET** `/api/payment/stone/status/:transactionId`

Consultar status de uma transação

**Exemplo:**

```
GET /api/payment/stone/status/abc123
```

---

#### **GET** `/api/payment/stone/health`

Verificar se o TEF está online

**Resposta:**

```json
{
  "success": true,
  "message": "TEF Stone está online"
}
```

## 🔧 Configuração no Server.js

Para ativar as rotas Stone, adicione no `server.js`:

```javascript
import * as stoneController from "./controllers/stonePinpadController.js";

// Rotas Stone Pinpad
app.post("/api/payment/stone/create", stoneController.createStonePayment);
app.post("/api/payment/stone/cancel", stoneController.cancelStonePayment);
app.get(
  "/api/payment/stone/status/:transactionId",
  stoneController.checkStoneStatus
);
app.get("/api/payment/stone/health", stoneController.checkStoneHealth);
```

## 🎯 Exemplo de Uso no Frontend

```javascript
const realizarPagamento = async () => {
  try {
    const response = await fetch(
      "http://localhost:3000/api/payment/stone/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: 1000, // R$ 10,00
          type: "CREDIT", // Crédito
          installments: 1, // À vista
          orderId: "ORDER_123",
        }),
      }
    );

    const data = await response.json();

    if (data.success && data.responseCode === "0000") {
      alert("✅ Pagamento Aprovado!");
      console.log("Transaction ID:", data.transactionId);
    } else {
      alert("❌ Pagamento Negado: " + data.responseMessage);
    }
  } catch (error) {
    console.error("Erro:", error);
    alert("Erro na comunicação. Verifique se o TEF Stone está rodando.");
  }
};
```

## ⚠️ Troubleshooting

### Erro: "TEF Stone não está disponível"

**Causa:** O aplicativo Stone não está rodando
**Solução:**

1. Abra o aplicativo Stone TEF
2. Verifique se está na porta 6800
3. Teste com: `curl http://localhost:6800/health`

### Erro: "ECONNREFUSED"

**Causa:** Servidor TEF não está escutando na porta 6800
**Solução:** Reinicie o aplicativo Stone

### Erro: Timeout (408)

**Causa:** Cliente demorou muito para passar o cartão
**Solução:** Operação é cancelada automaticamente após 2 minutos

## 🔄 Voltando para Mercado Pago

Para reverter e usar Mercado Pago novamente:

1. Abra `controllers/paymentController.js`
2. **Descomente** todo o código (remova os `/*` e `*/`)
3. Comente ou remova as rotas Stone do `server.js`

## 📚 Documentação Stone

- API Local: `http://localhost:6800/api/v1/transactions`
- Porta Padrão: **6800**
- Timeout Recomendado: **120 segundos** (2 minutos)

## ✅ Status Atual

- ✅ Controller Stone criado
- ✅ Controller Mercado Pago comentado (preservado)
- ⏳ Rotas precisam ser adicionadas no `server.js`
- ⏳ Frontend precisa ser adaptado para usar novas rotas

---

**Autor:** Backend Team  
**Data:** Dezembro 2025  
**Versão:** 1.0
