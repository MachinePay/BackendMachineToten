/**
 * Serviço de Pagamento Multi-tenant
 * Todas as funções aceitam storeConfig com credenciais da loja
 */

/**
 * Criar pagamento PIX (QR Code)
 * @param {Object} paymentData - { amount, description, orderId, email, payerName }
 * @param {Object} storeConfig - { mp_access_token, mp_device_id }
 * @returns {Promise<Object>} Dados do pagamento criado
 */
export async function createPixPayment(paymentData, storeConfig) {
  const { amount, description, orderId, email, payerName } = paymentData;
  const { mp_access_token } = storeConfig;

  if (!mp_access_token) {
    throw new Error(
      "Access Token do Mercado Pago não configurado para esta loja"
    );
  }

  try {
    console.log(
      `💚 [PIX] Criando pagamento de R$ ${amount} (loja: ${
        storeConfig.id || "N/A"
      })`
    );

    const idempotencyKey = `pix_${orderId || Date.now()}_${Date.now()}`;

    const response = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mp_access_token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(amount),
        description: description || "Pedido",
        payment_method_id: "pix",
        payer: {
          email: email || "cliente@loja.com",
          first_name: payerName || "Cliente",
        },
        external_reference: orderId,
        notification_url: `${
          process.env.FRONTEND_URL || "https://backendkioskpro.onrender.com"
        }/api/notifications/mercadopago`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ [PIX] Erro ao criar:", data);
      throw new Error(data.message || "Erro ao criar PIX");
    }

    const qrCodeBase64 =
      data.point_of_interaction?.transaction_data?.qr_code_base64;
    const qrCodeCopyPaste =
      data.point_of_interaction?.transaction_data?.qr_code;

    console.log(`✅ [PIX] Criado! Payment ID: ${data.id}`);

    return {
      paymentId: data.id,
      status: data.status,
      qrCodeBase64,
      qrCodeCopyPaste,
      type: "pix",
    };
  } catch (error) {
    console.error("❌ [PIX] Erro:", error);
    throw error;
  }
}

/**
 * Criar pagamento com Cartão via Point
 * @param {Object} paymentData - { amount, description, orderId }
 * @param {Object} storeConfig - { mp_access_token, mp_device_id }
 * @returns {Promise<Object>} Dados do pagamento criado
 */
export async function createCardPayment(paymentData, storeConfig) {
  const { amount, description, orderId } = paymentData;
  const { mp_access_token, mp_device_id } = storeConfig;

  if (!mp_access_token || !mp_device_id) {
    throw new Error(
      "Credenciais do Mercado Pago não configuradas para esta loja"
    );
  }

  try {
    console.log(
      `💳 [CARD] Criando pagamento de R$ ${amount} (Device: ${mp_device_id})`
    );

    const idempotencyKey = `card_${orderId}_${Date.now()}`;

    // Para Point Smart, usar a Point Integration API
    const response = await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${mp_device_id}/payment-intents`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          amount: parseFloat(amount),
          description: description || "Pedido",
          external_reference: orderId,
          notification_url: `${
            process.env.FRONTEND_URL || "https://backendkioskpro.onrender.com"
          }/api/notifications/mercadopago`,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ [CARD] Erro ao criar:", data);
      throw new Error(data.message || "Erro ao criar pagamento");
    }

    console.log(`✅ [CARD] Payment Intent criado! ID: ${data.id}`);
    console.log(`   Status: ${data.state}`);

    return {
      paymentIntentId: data.id,
      paymentId: data.payment?.id || null,
      status: data.state || "pending",
      type: "card",
      device_id: mp_device_id,
    };
  } catch (error) {
    console.error("❌ [CARD] Erro:", error);
    throw error;
  }
}

/**
 * Verificar status de pagamento
 * @param {string} paymentId - ID do pagamento
 * @param {Object} storeConfig - { mp_access_token }
 * @returns {Promise<Object>} Status do pagamento
 */
export async function checkPaymentStatus(paymentId, storeConfig) {
  const { mp_access_token } = storeConfig;

  if (!mp_access_token) {
    throw new Error("Access Token não configurado");
  }

  try {
    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Erro ao consultar pagamento");
    }

    return {
      id: data.id,
      status: data.status,
      status_detail: data.status_detail,
      transaction_amount: data.transaction_amount,
      external_reference: data.external_reference,
    };
  } catch (error) {
    console.error("❌ [STATUS] Erro:", error);
    throw error;
  }
}

/**
 * Cancelar pagamento
 * @param {string} paymentId - ID do pagamento
 * @param {Object} storeConfig - { mp_access_token }
 * @returns {Promise<Object>} Resultado do cancelamento
 */
export async function cancelPayment(paymentId, storeConfig) {
  const { mp_access_token } = storeConfig;

  if (!mp_access_token) {
    throw new Error("Access Token não configurado");
  }

  try {
    console.log(`🚫 [CANCEL] Cancelando pagamento ${paymentId}`);

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "cancelled" }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Erro ao cancelar pagamento");
    }

    console.log(`✅ [CANCEL] Pagamento cancelado`);

    return {
      id: data.id,
      status: data.status,
    };
  } catch (error) {
    console.error("❌ [CANCEL] Erro:", error);
    throw error;
  }
}

/**
 * Configurar Point Smart 2 (PDV)
 * @param {Object} storeConfig - { mp_access_token, mp_device_id }
 * @returns {Promise<Object>} Configuração da Point
 */
export async function configurePoint(storeConfig) {
  const { mp_access_token, mp_device_id } = storeConfig;

  if (!mp_access_token || !mp_device_id) {
    throw new Error("Credenciais da Point não configuradas");
  }

  try {
    console.log(`⚙️ [POINT] Configurando Device: ${mp_device_id}`);

    const response = await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${mp_device_id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operating_mode: "PDV",
        }),
      }
    );

    const data = await response.json();

    if (!response.ok && response.status !== 400) {
      throw new Error(data.message || "Erro ao configurar Point");
    }

    console.log(`✅ [POINT] Configurada em modo PDV`);

    return {
      device_id: mp_device_id,
      operating_mode: "PDV",
      status: "configured",
    };
  } catch (error) {
    console.error("❌ [POINT] Erro:", error);
    throw error;
  }
}

/**
 * Obter status da Point
 * @param {Object} storeConfig - { mp_access_token, mp_device_id }
 * @returns {Promise<Object>} Status da Point
 */
export async function getPointStatus(storeConfig) {
  const { mp_access_token, mp_device_id } = storeConfig;

  if (!mp_access_token || !mp_device_id) {
    throw new Error("Credenciais da Point não configuradas");
  }

  try {
    const response = await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${mp_device_id}`,
      {
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Erro ao consultar Point");
    }

    return {
      id: data.id,
      operating_mode: data.operating_mode,
      status: response.status,
    };
  } catch (error) {
    console.error("❌ [POINT-STATUS] Erro:", error);
    throw error;
  }
}

/**
 * Limpar fila de pagamentos pendentes
 * @param {Object} storeConfig - { mp_access_token, mp_device_id }
 * @returns {Promise<Object>} Resultado da limpeza
 */
export async function clearPaymentQueue(storeConfig) {
  const { mp_access_token, mp_device_id } = storeConfig;

  if (!mp_access_token || !mp_device_id) {
    throw new Error("Credenciais não configuradas");
  }

  try {
    console.log(`🧹 [QUEUE] Limpando fila do device ${mp_device_id}`);

    const response = await fetch(
      `https://api.mercadopago.com/point/integration-api/devices/${mp_device_id}/payment-intents`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${mp_access_token}`,
        },
      }
    );

    if (!response.ok && response.status !== 204) {
      const data = await response.json();
      throw new Error(data.message || "Erro ao limpar fila");
    }

    console.log(`✅ [QUEUE] Fila limpa com sucesso`);

    return {
      success: true,
      message: "Fila de pagamentos limpa",
    };
  } catch (error) {
    console.error("❌ [QUEUE] Erro:", error);
    throw error;
  }
}
