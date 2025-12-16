# 🏪 Stone Pinpad - Guia de Integração Frontend (Produção)

## 📋 Visão Geral

Este guia descreve como integrar o Stone Pinpad no **modo produção**, onde o frontend chama o TEF Stone **diretamente** via `localhost:6800`.

**Arquitetura:**

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Frontend   │────▶│  TEF Stone   │     │  Backend Render  │
│  (Totem)    │     │ localhost:6800│     │  (Nuvem)         │
└─────────────┘     └──────────────┘     └──────────────────┘
       │                                            ▲
       └────────────────────────────────────────────┘
              Registra transação aprovada
```

**Fluxo:**

1. Frontend chama TEF Stone local para processar pagamento
2. TEF retorna resultado (aprovado/negado)
3. Frontend envia resultado para backend (valida e registra)
4. Backend confirma e salva no banco de dados

---

## 🔧 Pré-requisitos

1. **TEF Stone instalado** no computador do totem
2. **Serviço TEF rodando** em `http://localhost:6800`
3. **Backend funcionando** (Render ou local)

---

## 💳 1. Processar Pagamento (Frontend → TEF)

O frontend chama o TEF Stone diretamente:

```javascript
// Função para processar pagamento Stone
async function processarPagamentoStone(
  valorEmReais,
  tipo = "CREDIT",
  parcelas = 1
) {
  try {
    // Converte valor para centavos
    const amountCentavos = Math.round(valorEmReais * 100);

    console.log(`💳 Processando pagamento Stone...`);
    console.log(`   Valor: R$ ${valorEmReais.toFixed(2)}`);
    console.log(`   Tipo: ${tipo}`);
    console.log(`   Parcelas: ${parcelas}`);

    // 1. Chama TEF Stone local
    const response = await fetch("http://localhost:6800/api/v1/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountCentavos,
        type: tipo.toUpperCase(), // "CREDIT" ou "DEBIT"
        installments: parcelas,
      }),
    });

    if (!response.ok) {
      throw new Error(`TEF respondeu com status ${response.status}`);
    }

    const data = await response.json();

    // 2. Verifica se foi aprovado
    if (data.responseCode === "0000") {
      console.log("✅ Pagamento APROVADO!");
      console.log(`   Transaction ID: ${data.transactionId}`);
      console.log(`   Authorization: ${data.authorizationCode}`);
      console.log(`   Bandeira: ${data.cardBrand}`);

      return {
        success: true,
        transactionId: data.transactionId,
        authorizationCode: data.authorizationCode,
        cardBrand: data.cardBrand,
        amount: amountCentavos,
        type: tipo.toUpperCase(),
        installments: parcelas,
      };
    } else {
      console.log("❌ Pagamento NEGADO!");
      console.log(`   Código: ${data.responseCode}`);

      return {
        success: false,
        error: "Pagamento negado",
        responseCode: data.responseCode,
      };
    }
  } catch (error) {
    console.error("❌ Erro ao processar pagamento Stone:", error);

    // Verifica se é erro de conexão
    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("ECONNREFUSED")
    ) {
      return {
        success: false,
        error:
          "TEF Stone não está disponível. Verifique se o serviço está rodando.",
      };
    }

    return {
      success: false,
      error: error.message,
    };
  }
}
```

---

## ✅ 2. Registrar no Backend (Frontend → Backend)

Após aprovação, envie para o backend registrar:

```javascript
async function registrarTransacaoStone(orderId, transactionData, storeId) {
  try {
    const response = await fetch(
      "https://backendkioskpro.onrender.com/api/payment/stone/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-store-id": storeId, // Importante!
        },
        body: JSON.stringify({
          orderId: orderId,
          transactionId: transactionData.transactionId,
          authorizationCode: transactionData.authorizationCode,
          amount: transactionData.amount,
          type: transactionData.type,
          installments: transactionData.installments,
          cardBrand: transactionData.cardBrand,
          responseCode: "0000", // Aprovado
          storeId: storeId,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Backend respondeu com status ${response.status}`);
    }

    const data = await response.json();
    console.log("✅ Transação registrada no backend:", data);

    return data;
  } catch (error) {
    console.error("❌ Erro ao registrar no backend:", error);
    throw error;
  }
}
```

---

## 🔄 3. Fluxo Completo de Pagamento

```javascript
async function finalizarPedidoComStone(pedido) {
  try {
    const storeId = "sushiman1"; // Ou pegar do contexto

    // 1. Processar pagamento no TEF local
    console.log("🔄 Etapa 1/3: Processando pagamento no TEF...");
    const resultadoPagamento = await processarPagamentoStone(
      pedido.total,
      "CREDIT", // ou 'DEBIT'
      1 // parcelas
    );

    if (!resultadoPagamento.success) {
      // Pagamento negado ou erro
      alert(`Pagamento recusado: ${resultadoPagamento.error}`);
      return { success: false, error: resultadoPagamento.error };
    }

    // 2. Registrar transação no backend
    console.log("🔄 Etapa 2/3: Registrando transação no backend...");
    await registrarTransacaoStone(pedido.id, resultadoPagamento, storeId);

    // 3. Atualizar status do pedido
    console.log("🔄 Etapa 3/3: Atualizando status do pedido...");
    await fetch(
      `https://backendkioskpro.onrender.com/api/orders/${pedido.id}/payment-status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-store-id": storeId,
        },
        body: JSON.stringify({
          paymentStatus: "paid",
          paymentId: resultadoPagamento.transactionId,
        }),
      }
    );

    console.log("✅ PEDIDO FINALIZADO COM SUCESSO!");
    return { success: true, transaction: resultadoPagamento };
  } catch (error) {
    console.error("❌ Erro no fluxo de pagamento:", error);
    return { success: false, error: error.message };
  }
}
```

---

## 🔍 4. Consultar Status de Transação

```javascript
async function consultarStatusStone(transactionId) {
  try {
    const response = await fetch(
      `http://localhost:6800/api/v1/transactions/${transactionId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Erro ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Erro ao consultar status:", error);
    return null;
  }
}
```

---

## ❌ 5. Cancelar Transação

```javascript
async function cancelarTransacaoStone(transactionId) {
  try {
    const response = await fetch(
      `http://localhost:6800/api/v1/transactions/${transactionId}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Erro ${response.status}`);
    }

    const data = await response.json();
    console.log("✅ Transação cancelada:", data);
    return data;
  } catch (error) {
    console.error("Erro ao cancelar:", error);
    throw error;
  }
}
```

---

## 🏥 6. Health Check do TEF

```javascript
async function verificarTEFDisponivel() {
  try {
    const response = await fetch("http://localhost:6800/health", {
      method: "GET",
      timeout: 3000, // 3 segundos
    });

    return response.ok;
  } catch (error) {
    console.warn("⚠️ TEF Stone não está disponível:", error.message);
    return false;
  }
}

// Verificar ao carregar a página
window.addEventListener("load", async () => {
  const tefDisponivel = await verificarTEFDisponivel();

  if (!tefDisponivel) {
    console.error("❌ TEF Stone não disponível!");
    alert(
      "ATENÇÃO: Sistema de pagamento não está disponível. Contate o suporte."
    );
  } else {
    console.log("✅ TEF Stone disponível e funcionando");
  }
});
```

---

## 🔐 Segurança

### ✅ Boas Práticas:

1. **Sempre registre no backend** após aprovação
2. **Valide responseCode** antes de prosseguir (`0000` = aprovado)
3. **Implemente timeout** (120 segundos recomendado)
4. **Trate erros** de conexão graciosamente
5. **Logs detalhados** para auditoria

### ❌ Nunca:

- Confiar apenas na resposta do frontend
- Pular validação no backend
- Expor credenciais sensíveis
- Processar pagamentos sem confirmação

---

## 🧪 Testando a Integração

### Teste 1: TEF Disponível

```bash
curl http://localhost:6800/health
# Deve retornar: 200 OK
```

### Teste 2: Processar Pagamento de Teste

```bash
curl -X POST http://localhost:6800/api/v1/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "type": "CREDIT",
    "installments": 1
  }'
```

### Teste 3: Registrar no Backend

```bash
curl -X POST https://backendkioskpro.onrender.com/api/payment/stone/register \
  -H "Content-Type: application/json" \
  -H "x-store-id: sushiman1" \
  -d '{
    "orderId": "order_test_123",
    "transactionId": "ABC123",
    "authorizationCode": "456789",
    "amount": 10050,
    "type": "CREDIT",
    "installments": 1,
    "cardBrand": "VISA",
    "responseCode": "0000",
    "storeId": "sushiman1"
  }'
```

---

## 📊 Códigos de Resposta Stone

| Código | Significado                    |
| ------ | ------------------------------ |
| `0000` | ✅ Aprovado                    |
| `0001` | ❌ Negado - saldo insuficiente |
| `0002` | ❌ Negado - cartão bloqueado   |
| `0003` | ❌ Negado - senha incorreta    |
| `9999` | ❌ Erro no terminal            |

---

## 🆘 Troubleshooting

### Problema: "Failed to fetch" ou CORS

**Causa:** TEF Stone não permite CORS por padrão  
**Solução:** Configure CORS no TEF ou use proxy local

### Problema: "TEF não disponível"

**Causa:** Serviço TEF não está rodando  
**Solução:**

```bash
# Windows - Verificar serviço
netstat -ano | findstr :6800

# Iniciar serviço Stone
# (Consultar documentação Stone para comando específico)
```

### Problema: Timeout na transação

**Causa:** Cliente demorou para inserir cartão  
**Solução:** Implemente timeout de 120s e notifique o usuário

---

## 📞 Suporte

- **Documentação Stone:** [stone.com.br/desenvolvedores](https://stone.com.br/desenvolvedores)
- **Backend Issues:** GitHub Issues do projeto
- **TEF não funciona:** Contate suporte Stone

---

## 🔄 Migração Futura (Backend Local)

Se quiser rodar backend localmente no futuro:

1. Configure backend na mesma máquina do totem
2. Use endpoint `/api/payment/stone/create` (backend chama TEF)
3. Frontend aponta para `http://localhost:3001`

Vantagens:

- Lógica centralizada no backend
- Melhor segurança e auditoria
- Mais fácil de debugar

---

**✅ Pronto para produção!** 🚀
