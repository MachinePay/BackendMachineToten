import * as paymentService from "../services/paymentService.js";

/**
 * Extrai e valida storeConfig do req.store
 * @param {Request} req - Request do Express
 * @returns {Object} storeConfig - { id, name, mp_access_token, mp_device_id }
 * @throws {Error} Se store não configurada
 */
function getStoreConfig(req) {
  if (!req.store) {
    throw new Error("Loja não identificada. Envie o header x-store-id");
  }

  const { id, name, mp_access_token, mp_device_id } = req.store;

  if (!mp_access_token) {
    throw new Error(
      `Credenciais do Mercado Pago não configuradas para a loja: ${name || id}`
    );
  }

  return { id, name, mp_access_token, mp_device_id };
}

/**
 * POST /api/payment/create-pix
 * Criar pagamento PIX (QR Code)
 */
export async function createPix(req, res) {
  try {
    const storeConfig = getStoreConfig(req);
    const { amount, description, orderId, email, payerName } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Campo amount é obrigatório" });
    }

    const result = await paymentService.createPixPayment(
      { amount, description, orderId, email, payerName },
      storeConfig
    );

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao criar PIX:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao criar PIX" });
  }
}

/**
 * POST /api/payment/create
 * Criar pagamento com cartão via Point
 */
export async function createCard(req, res) {
  try {
    const storeConfig = getStoreConfig(req);
    const { amount, description, orderId } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Campo amount é obrigatório" });
    }

    if (!storeConfig.mp_device_id) {
      return res
        .status(400)
        .json({ error: "Device ID não configurado para esta loja" });
    }

    const result = await paymentService.createCardPayment(
      { amount, description, orderId },
      storeConfig
    );

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao criar pagamento com cartão:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao criar pagamento" });
  }
}

/**
 * GET /api/payment/status/:paymentId
 * Verificar status de pagamento
 */
export async function checkStatus(req, res) {
  try {
    const storeConfig = getStoreConfig(req);
    const { paymentId } = req.params;

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId é obrigatório" });
    }

    const result = await paymentService.checkPaymentStatus(
      paymentId,
      storeConfig
    );

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao verificar status:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao verificar pagamento" });
  }
}

/**
 * DELETE /api/payment/cancel/:paymentId
 * Cancelar pagamento
 */
export async function cancel(req, res) {
  try {
    const storeConfig = getStoreConfig(req);
    const { paymentId } = req.params;

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId é obrigatório" });
    }

    const result = await paymentService.cancelPayment(paymentId, storeConfig);

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao cancelar pagamento:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao cancelar pagamento" });
  }
}

/**
 * POST /api/payment/point/configure
 * Configurar Point em modo PDV
 */
export async function configurePoint(req, res) {
  try {
    const storeConfig = getStoreConfig(req);

    if (!storeConfig.mp_device_id) {
      return res
        .status(400)
        .json({ error: "Device ID não configurado para esta loja" });
    }

    const result = await paymentService.configurePoint(storeConfig);

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao configurar Point:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao configurar Point" });
  }
}

/**
 * GET /api/payment/point/status
 * Obter status da Point
 */
export async function getPointStatus(req, res) {
  try {
    const storeConfig = getStoreConfig(req);

    if (!storeConfig.mp_device_id) {
      return res
        .status(400)
        .json({ error: "Device ID não configurado para esta loja" });
    }

    const result = await paymentService.getPointStatus(storeConfig);

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao consultar Point:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao consultar Point" });
  }
}

/**
 * POST /api/payment/clear-queue
 * Limpar fila de pagamentos pendentes
 */
export async function clearQueue(req, res) {
  try {
    const storeConfig = getStoreConfig(req);

    if (!storeConfig.mp_device_id) {
      return res
        .status(400)
        .json({ error: "Device ID não configurado para esta loja" });
    }

    const result = await paymentService.clearPaymentQueue(storeConfig);

    return res.json(result);
  } catch (error) {
    console.error("[Controller] Erro ao limpar fila:", error);
    return res
      .status(500)
      .json({ error: error.message || "Erro ao limpar fila" });
  }
}
