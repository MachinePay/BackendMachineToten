import axios from "axios";

/**
 * ===================================================
 * STONE PINPAD - CONTROLLER DE PAGAMENTOS
 * ===================================================
 *
 * Este arquivo gerencia pagamentos via Pinpad Stone TEF
 * Comunicação local via API REST (http://localhost:6800)
 *
 * Documentação Stone: API v1 Transactions
 */

/**
 * Configuração do servidor TEF local
 * Endereço padrão conforme instalação Stone
 */
const STONE_TEF_URL = "http://localhost:6800/api/v1/transactions";

/**
 * POST /api/payment/stone/create
 * Criar pagamento via Stone Pinpad
 *
 * Body esperado:
 * {
 *   amount: 100,           // Valor em centavos (100 = R$ 1,00)
 *   type: "CREDIT",        // "CREDIT" ou "DEBIT"
 *   installments: 1,       // Número de parcelas
 *   orderId: "order_123"   // ID do pedido (opcional)
 * }
 */
export async function createStonePayment(req, res) {
  try {
    const { amount, type, installments, orderId } = req.body;

    // Validações
    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: "Campo 'amount' é obrigatório e deve ser maior que zero",
      });
    }

    if (!type || !["CREDIT", "DEBIT"].includes(type.toUpperCase())) {
      return res.status(400).json({
        error: "Campo 'type' deve ser 'CREDIT' ou 'DEBIT'",
      });
    }

    // Prepara payload para o Pinpad Stone
    const payload = {
      amount: parseInt(amount), // Garante que é número inteiro
      type: type.toUpperCase(),
      installments: parseInt(installments) || 1,
      installmentType: "MERCHANT", // Tipo de parcelamento
    };

    console.log(`💳 [STONE] Enviando pagamento para Pinpad...`);
    console.log(`   Valor: R$ ${(amount / 100).toFixed(2)}`);
    console.log(`   Tipo: ${type}`);
    console.log(`   Parcelas: ${installments || 1}`);
    if (orderId) console.log(`   Order ID: ${orderId}`);

    // Envia requisição para o servidor TEF local
    const response = await axios.post(STONE_TEF_URL, payload, {
      timeout: 120000, // 2 minutos de timeout (cartão pode demorar)
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log(`✅ [STONE] Resposta recebida:`, response.data);

    // Verifica se foi aprovado
    const approved = response.data.responseCode === "0000";

    return res.json({
      success: approved,
      responseCode: response.data.responseCode,
      responseMessage: response.data.responseMessage,
      transactionId: response.data.transactionId,
      authorizationCode: response.data.authorizationCode,
      cardBrand: response.data.cardBrand,
      cardNumber: response.data.cardNumber, // Últimos 4 dígitos
      orderId: orderId,
      raw: response.data, // Resposta completa
    });
  } catch (error) {
    console.error("❌ [STONE] Erro na comunicação com Pinpad:", error.message);

    // Erro de conexão - TEF não está rodando
    if (error.code === "ECONNREFUSED") {
      return res.status(503).json({
        error: "TEF Stone não está disponível",
        message: "Verifique se o aplicativo Stone está aberto e rodando",
        details: "Não foi possível conectar em http://localhost:6800",
      });
    }

    // Timeout - Operação demorou demais
    if (error.code === "ECONNABORTED") {
      return res.status(408).json({
        error: "Timeout na operação",
        message: "O pagamento demorou muito tempo e foi cancelado",
      });
    }

    // Erro genérico
    return res.status(500).json({
      error: "Erro ao processar pagamento Stone",
      message: error.message,
      details: error.response?.data || null,
    });
  }
}

/**
 * POST /api/payment/stone/cancel
 * Cancelar transação Stone
 *
 * Body esperado:
 * {
 *   transactionId: "abc123"  // ID da transação a ser cancelada
 * }
 */
export async function cancelStonePayment(req, res) {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        error: "Campo 'transactionId' é obrigatório",
      });
    }

    console.log(`🔄 [STONE] Cancelando transação: ${transactionId}`);

    // Endpoint de cancelamento Stone (pode variar conforme versão)
    const cancelUrl = `${STONE_TEF_URL}/${transactionId}/cancel`;

    const response = await axios.post(
      cancelUrl,
      {},
      {
        timeout: 60000, // 1 minuto
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ [STONE] Cancelamento processado:`, response.data);

    return res.json({
      success: true,
      message: "Transação cancelada com sucesso",
      transactionId: transactionId,
      raw: response.data,
    });
  } catch (error) {
    console.error("❌ [STONE] Erro ao cancelar:", error.message);

    return res.status(500).json({
      error: "Erro ao cancelar pagamento Stone",
      message: error.message,
      details: error.response?.data || null,
    });
  }
}

/**
 * GET /api/payment/stone/status/:transactionId
 * Verificar status de transação Stone
 */
export async function checkStoneStatus(req, res) {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({
        error: "transactionId é obrigatório",
      });
    }

    console.log(`🔍 [STONE] Consultando status: ${transactionId}`);

    // Endpoint de consulta Stone
    const statusUrl = `${STONE_TEF_URL}/${transactionId}`;

    const response = await axios.get(statusUrl, {
      timeout: 30000, // 30 segundos
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log(`✅ [STONE] Status obtido:`, response.data);

    return res.json({
      success: true,
      transactionId: transactionId,
      status: response.data.status,
      raw: response.data,
    });
  } catch (error) {
    console.error("❌ [STONE] Erro ao consultar status:", error.message);

    return res.status(500).json({
      error: "Erro ao consultar status Stone",
      message: error.message,
      details: error.response?.data || null,
    });
  }
}

/**
 * GET /api/payment/stone/health
 * Verificar se o TEF Stone está disponível
 */
export async function checkStoneHealth(req, res) {
  try {
    console.log(`🏥 [STONE] Verificando saúde do TEF...`);

    // Tenta fazer ping no servidor TEF
    const response = await axios.get("http://localhost:6800/health", {
      timeout: 5000,
    });

    return res.json({
      success: true,
      message: "TEF Stone está online",
      status: response.data,
    });
  } catch (error) {
    console.error("❌ [STONE] TEF não disponível:", error.message);

    return res.status(503).json({
      success: false,
      message: "TEF Stone não está disponível",
      error: error.message,
    });
  }
}
