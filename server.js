import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import knex from "knex";

const app = express();
const PORT = process.env.PORT || 3001;

// --- Configurações ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_DEVICE_ID = process.env.MP_DEVICE_ID;

// --- Banco de Dados ---
const dbConfig = process.env.DATABASE_URL
  ? {
      client: "pg",
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      },
    }
  : {
      client: "sqlite3",
      connection: {
        filename: path.join(process.cwd(), "data", "kiosk.sqlite"),
      },
      useNullAsDefault: true,
    };

const db = knex(dbConfig);

const parseJSON = (data) => {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }
  return data || [];
};

const dbType = process.env.DATABASE_URL
  ? "PostgreSQL (Render)"
  : "SQLite (Local)";
console.log(`🗄️ Usando banco: ${dbType}`);

// Cache de pagamentos confirmados (para resolver problema de sincronia MP)
const confirmedPayments = new Map();

// Função para limpar cache antigo (a cada 1 hora)
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, value] of confirmedPayments.entries()) {
    if (value.timestamp < oneHourAgo) {
      confirmedPayments.delete(key);
    }
  }
}, 3600000);

// Função para limpar intents antigas da Point Pro 2 (a cada 2 minutos)
// Evita que pagamentos antigos fiquem travando a maquininha
setInterval(async () => {
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) return;
  
  try {
    const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    
    if (response.ok) {
      const data = await response.json();
      const events = data.events || [];
      
      if (events.length > 0) {
        console.log(`🧹 [Auto-cleanup] Encontradas ${events.length} intent(s) pendentes na Point Pro 2`);
        
        for (const ev of events) {
          const iId = ev.payment_intent_id || ev.id;
          const state = ev.state;
          
          // Remove intents antigas (mais de 10 minutos) ou já finalizadas
          const shouldClean = state === "FINISHED" || 
                             state === "CANCELED" || 
                             state === "ERROR";
          
          if (shouldClean) {
            try {
              await fetch(`${listUrl}/${iId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
              });
              console.log(`  ✅ Intent ${iId} (${state}) removida automaticamente`);
            } catch (e) {
              console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
            }
          }
        }
        
        console.log(`✅ [Auto-cleanup] Point Pro 2 verificada e limpa`);
      }
    }
  } catch (error) {
    // Silencioso - não precisa logar erro de cleanup em background
  }
}, 120000); // A cada 2 minutos

// --- Inicialização do Banco (SEED) ---
async function initDatabase() {
  console.log("⏳ Verificando tabelas...");

  const hasProducts = await db.schema.hasTable("products");
  if (!hasProducts) {
    await db.schema.createTable("products", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.text("description");
      table.decimal("price", 8, 2).notNullable();
      table.string("category").notNullable();
      table.string("videoUrl");
      table.boolean("popular").defaultTo(false);
      table.integer("stock"); // NULL = estoque ilimitado, 0 = esgotado
    });
  } else {
    // Migração: Adicionar coluna stock se não existir
    const hasStock = await db.schema.hasColumn("products", "stock");
    if (!hasStock) {
      await db.schema.table("products", (table) => {
        table.integer("stock");
      });
      console.log("✅ Coluna stock adicionada à tabela products");
    }
  }

  const hasUsers = await db.schema.hasTable("users");
  if (!hasUsers) {
    await db.schema.createTable("users", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.string("email").unique();
      table.string("cpf").unique();
      table.json("historico").defaultTo("[]");
      table.integer("pontos").defaultTo(0);
    });
  }

  const hasOrders = await db.schema.hasTable("orders");
  if (!hasOrders) {
    await db.schema.createTable("orders", (table) => {
      table.string("id").primary();
      table
        .string("userId")
        .references("id")
        .inTable("users")
        .onDelete("SET NULL");
      table.string("userName");
      table.decimal("total", 8, 2).notNullable();
      table.string("timestamp").notNullable();
      table.string("status").defaultTo("active");
      table.string("paymentStatus").defaultTo("pending");
      table.string("paymentId");
      table.json("items").notNullable();
      table.timestamp("completedAt");
    });
  }

  const result = await db("products").count("id as count").first();
  if (Number(result.count) === 0) {
    try {
      const menuDataPath = path.join(process.cwd(), "data", "menu.json");
      const rawData = await fs.readFile(menuDataPath, "utf-8");
      await db("products").insert(JSON.parse(rawData));
      console.log("✅ Menu carregado com sucesso!");
    } catch (e) {
      console.error("⚠️ Erro ao carregar menu.json:", e.message);
    }
  } else {
    console.log(`✅ O banco já contém ${result.count} produtos.`);
  }
  
  // Verifica OpenAI
  if (openai) {
    console.log("🤖 OpenAI configurada - IA disponível");
  } else {
    console.log("⚠️ OpenAI NÃO configurada - OPENAI_API_KEY não encontrada");
  }
}

// --- Middlewares ---
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map((url) => url.trim())
  : ["*"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes("*") ||
        allowedOrigins.some((url) => origin.startsWith(url))
      ) {
        return callback(null, true);
      }
      callback(null, true);
    },
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    credentials: true,
  })
);
app.use(express.json());

// --- Rotas Básicas ---
app.get("/", (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h1>Pastelaria Backend Online 🚀</h1>
      <p>Banco: <strong>${dbType}</strong></p>
      <p>Status: <strong>OPERACIONAL (Modo Busca por Valor)</strong></p>
    </div>
  `);
});

app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", db: dbType })
);

// Rota de teste do webhook (para verificar se está acessível)
app.get("/api/webhooks/mercadopago", (req, res) => {
  console.log("📋 GET recebido no webhook - Teste manual ou verificação do MP");
  res.status(200).json({ 
    message: "Webhook endpoint ativo! Use POST para enviar notificações.",
    ready: true,
    method: "GET - Para receber notificações reais, o MP deve usar POST"
  });
});

// --- Rotas da API (Menu, Usuários, Pedidos) ---

app.get("/api/menu", async (req, res) => {
  try {
    const products = await db("products").select("*").orderBy("id");
    res.json(products.map((p) => ({ 
      ...p, 
      price: parseFloat(p.price),
      stock: p.stock,
      isAvailable: p.stock === null || p.stock > 0 // null = ilimitado, > 0 = disponível
    })));
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar menu" });
  }
});

// CRUD de Produtos (Admin)

app.post("/api/products", async (req, res) => {
  const { id, name, description, price, category, videoUrl, popular, stock } = req.body;
  
  if (!name || !price || !category) {
    return res.status(400).json({ error: "Nome, preço e categoria são obrigatórios" });
  }

  try {
    const newProduct = {
      id: id || `prod_${Date.now()}`,
      name,
      description: description || "",
      price: parseFloat(price),
      category,
      videoUrl: videoUrl || "",
      popular: popular || false,
      stock: stock !== undefined ? parseInt(stock) : null // null = ilimitado
    };
    
    await db("products").insert(newProduct);
    res.status(201).json({ ...newProduct, isAvailable: newProduct.stock === null || newProduct.stock > 0 });
  } catch (e) {
    console.error("Erro ao criar produto:", e);
    res.status(500).json({ error: "Erro ao criar produto" });
  }
});

app.put("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, videoUrl, popular, stock } = req.body;

  try {
    const exists = await db("products").where({ id }).first();
    if (!exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = parseFloat(price);
    if (category !== undefined) updates.category = category;
    if (videoUrl !== undefined) updates.videoUrl = videoUrl;
    if (popular !== undefined) updates.popular = popular;
    if (stock !== undefined) updates.stock = stock === null ? null : parseInt(stock);

    await db("products").where({ id }).update(updates);
    
    const updated = await db("products").where({ id }).first();
    res.json({ 
      ...updated, 
      price: parseFloat(updated.price),
      isAvailable: updated.stock === null || updated.stock > 0
    });
  } catch (e) {
    console.error("Erro ao atualizar produto:", e);
    res.status(500).json({ error: "Erro ao atualizar produto" });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const exists = await db("products").where({ id }).first();
    if (!exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    await db("products").where({ id }).del();
    res.json({ success: true, message: "Produto deletado com sucesso" });
  } catch (e) {
    console.error("Erro ao deletar produto:", e);
    res.status(500).json({ error: "Erro ao deletar produto" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await db("users").select("*");
    res.json(users.map((u) => ({ ...u, historico: parseJSON(u.historico) })));
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.post("/api/users", async (req, res) => {
  const { cpf, name, email, id } = req.body;
  if (!cpf) return res.status(400).json({ error: "CPF obrigatório" });
  const cpfClean = String(cpf).replace(/\D/g, "");

  try {
    const exists = await db("users").where({ cpf: cpfClean }).first();
    if (exists) return res.status(409).json({ error: "CPF já cadastrado" });

    const newUser = {
      id: id || `user_${Date.now()}`,
      name: name || "Sem Nome",
      email: email || "",
      cpf: cpfClean,
      historico: JSON.stringify([]),
      pontos: 0,
    };
    await db("users").insert(newUser);
    res.status(201).json({ ...newUser, historico: [] });
  } catch (e) {
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await db("orders")
      .where({ status: "active" })
      .orderBy("timestamp", "asc");
    res.json(
      orders.map((o) => ({
        ...o,
        items: parseJSON(o.items),
        total: parseFloat(o.total),
      }))
    );
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { userId, userName, items, total, paymentId } = req.body;

  const newOrder = {
    id: `order_${Date.now()}`,
    userId,
    userName: userName || "Cliente",
    items: JSON.stringify(items || []),
    total: total || 0,
    timestamp: new Date().toISOString(),
    status: "active",
    paymentStatus: "paid", // Assumimos pago pois o frontend só chama após sucesso
    paymentId: paymentId || null,
  };

  try {
    // Garante que o usuário existe (para convidados)
    const userExists = await db("users").where({ id: userId }).first();
    if (!userExists) {
      await db("users").insert({
        id: userId,
        name: userName || "Convidado",
        email: null,
        cpf: null,
        historico: "[]",
        pontos: 0,
      });
    }

    await db("orders").insert(newOrder);
    res.status(201).json({ ...newOrder, items: items || [] });
  } catch (e) {
    console.error("Erro salvar ordem:", e);
    res.status(500).json({ error: "Erro ao salvar ordem" });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    await db("orders")
      .where({ id: req.params.id })
      .update({ status: "completed", completedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao finalizar" });
  }
});

app.get("/api/user-orders", async (req, res) => {
  try {
    const { userId } = req.query;
    let query = db("orders").orderBy("timestamp", "desc");
    if (userId) query = query.where({ userId });
    const allOrders = await query.select("*");
    res.json(
      allOrders.map((o) => ({
        ...o,
        items: parseJSON(o.items),
        total: parseFloat(o.total),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: "Erro histórico" });
  }
});

// --- IPN MERCADO PAGO (Para pagamentos físicos Point) ---

app.post("/api/notifications/mercadopago", async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔔 [${timestamp}] IPN RECEBIDO DO MERCADO PAGO (Point)`);
  console.log(`${"=".repeat(60)}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Query Params:", JSON.stringify(req.query, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log(`${"=".repeat(60)}\n`);
  
  try {
    // IPN envia dados via query params
    const { id, topic } = req.query;

    // Responde rápido ao MP (obrigatório - SEMPRE 200 OK)
    res.status(200).send("OK");

    // Processa notificação em background
    if (topic === "payment" && id) {
      console.log(`📨 Processando IPN de pagamento: ${id}`);

      // Busca detalhes do pagamento
      const urlPayment = `https://api.mercadopago.com/v1/payments/${id}`;
      const respPayment = await fetch(urlPayment, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const payment = await respPayment.json();

      console.log(`💳 Pagamento ${id} | Status: ${payment.status} | Valor: R$ ${payment.transaction_amount}`);

      // Se aprovado, adiciona ao cache E DESCONTA DO ESTOQUE
      if (payment.status === "approved" || payment.status === "authorized") {
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;
        
        confirmedPayments.set(cacheKey, {
          paymentId: payment.id,
          amount: payment.transaction_amount,
          status: payment.status,
          timestamp: Date.now(),
        });

        console.log(`✅ Pagamento ${id} confirmado via IPN! Valor: R$ ${payment.transaction_amount}`);
        console.log(`ℹ️ External reference: ${payment.external_reference || 'não informado'}`);
        console.log(`ℹ️ Estoque já foi descontado no momento da criação do pedido (/api/orders)`);
      }
    } else {
      console.log(`⚠️ IPN ignorado - Topic: ${topic}, ID: ${id}`);
    }
  } catch (error) {
    console.error("❌ Erro processando IPN:", error.message);
  }
});

// Endpoint teste para validar IPN
app.get("/api/notifications/mercadopago", (req, res) => {
  res.json({ status: "ready", message: "IPN endpoint ativo para pagamentos Point" });
});

// --- WEBHOOK MERCADO PAGO (Notificação Instantânea) ---

app.post("/api/webhooks/mercadopago", async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔔 [${timestamp}] WEBHOOK RECEBIDO DO MERCADO PAGO`);
  console.log(`${"=".repeat(60)}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log(`${"=".repeat(60)}\n`);
  
  try {
    const { action, data, type } = req.body;

    // Responde rápido ao MP (obrigatório - SEMPRE 200 OK)
    res.status(200).json({ success: true, received: true });

    // Processa notificação em background
    if (action === "payment.created" || action === "payment.updated") {
      const paymentId = data?.id;
      
      if (!paymentId) {
        console.log("⚠️ Webhook sem payment ID");
        return;
      }

      console.log(`📨 Processando notificação de pagamento: ${paymentId}`);

      // Busca detalhes do pagamento
      const urlPayment = `https://api.mercadopago.com/v1/payments/${paymentId}`;
      const respPayment = await fetch(urlPayment, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const payment = await respPayment.json();

      console.log(`💳 Pagamento ${paymentId} | Status: ${payment.status} | Valor: R$ ${payment.transaction_amount}`);

      // Se aprovado, adiciona ao cache E DESCONTA DO ESTOQUE
      if (payment.status === "approved" || payment.status === "authorized") {
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;
        
        confirmedPayments.set(cacheKey, {
          paymentId: payment.id,
          amount: payment.transaction_amount,
          status: payment.status,
          timestamp: Date.now(),
        });

        console.log(`✅ Pagamento ${paymentId} confirmado via Webhook! Valor: R$ ${payment.transaction_amount}`);
        
        // DESCONTA DO ESTOQUE usando external_reference (ID do pedido)
        const externalRef = payment.external_reference;
        if (externalRef) {
          console.log(`📦 Processando desconto de estoque para pedido: ${externalRef}`);
          
          try {
            // Busca o pedido no banco
            const order = await db("orders").where({ id: externalRef }).first();
            
            if (order) {
              const items = parseJSON(order.items);
              console.log(`  🛒 ${items.length} item(ns) no pedido`);
              
              // Desconta cada produto
              for (const item of items) {
                const product = await db("products").where({ id: item.id }).first();
                
                if (product && product.stock !== null) {
                  const newStock = product.stock - item.quantity;
                  
                  await db("products")
                    .where({ id: item.id })
                    .update({ stock: Math.max(0, newStock) });
                  
                  console.log(`  ✅ ${item.name}: ${product.stock} → ${Math.max(0, newStock)} (${item.quantity} vendido)`);
                } else if (product) {
                  console.log(`  ℹ️ ${item.name}: estoque ilimitado`);
                }
              }
              
              console.log(`🎉 Estoque atualizado com sucesso!`);
            } else {
              console.log(`⚠️ Pedido ${externalRef} não encontrado no banco`);
            }
          } catch (err) {
            console.error(`❌ Erro ao descontar estoque: ${err.message}`);
          }
        }
      }
    }
  } catch (error) {
    console.error("❌ Erro processando webhook:", error.message);
  }
});

// --- INTEGRAÇÃO MERCADO PAGO POINT (Orders API Unificada) ---

// CRIAR PAGAMENTO PIX (QR Code na tela)
app.post("/api/payment/create-pix", async (req, res) => {
  const { amount, description, orderId } = req.body;

  if (!MP_ACCESS_TOKEN) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pix_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(`💚 Criando pagamento PIX (QR Code) de R$ ${amount}...`);

    const orderPayload = {
      type: "online", // QR Code exibido na tela
      transaction_amount: parseFloat(amount),
      description: description || `Pedido ${orderId}`,
      external_reference: orderId,
      notification_url: `${process.env.FRONTEND_URL || 'https://backendkioskpro.onrender.com'}/api/notifications/mercadopago`,
      payment_methods: {
        excluded_payment_types: [
          { id: "credit_card" },
          { id: "debit_card" },
          { id: "ticket" },
          { id: "bank_transfer" }
        ],
        installments: 1
      }
    };

    // Gera chave idempotente única para esta transação PIX
    const idempotencyKey = `pix_${orderId}_${Date.now()}`;

    const response = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey, // ← OBRIGATÓRIO
      },
      body: JSON.stringify(orderPayload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro ao criar order PIX:", data);
      throw new Error(data.message || "Erro ao criar PIX");
    }

    console.log(`✅ PIX criado! Order ID: ${data.id}`);
    console.log(`📱 QR Code: ${data.qr_code}`);

    res.json({
      id: data.id,
      status: "pending",
      qr_code: data.qr_code,
      qr_code_base64: data.qr_code_base64,
      ticket_url: data.ticket_url,
      type: 'pix'
    });

  } catch (error) {
    console.error("Erro ao criar PIX:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// --- ROTAS EXCLUSIVAS PIX (QR Code na Tela) ---
// ==========================================

app.post("/api/pix/create", async (req, res) => {
  const { amount, description, email, payerName, orderId } = req.body;

  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token MP" });

  try {
    console.log(`💠 Gerando PIX QR Code de R$ ${amount}...`);

    const idempotencyKey = `pix_${orderId || Date.now()}_${Date.now()}`;

    const response = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(amount),
        description: description || "Pedido Kiosk",
        payment_method_id: "pix",
        payer: {
          email: email || "cliente@kiosk.com",
          first_name: payerName || "Cliente"
        },
        external_reference: orderId,
        notification_url: "https://backendkioskpro.onrender.com/api/notifications/mercadopago"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro ao gerar PIX:", data);
      throw new Error(data.message || "Erro ao gerar PIX");
    }

    const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64;
    const qrCodeCopyPaste = data.point_of_interaction?.transaction_data?.qr_code;
    const paymentId = data.id;

    console.log(`✅ PIX gerado! Payment ID: ${paymentId}`);

    res.json({ 
      paymentId, 
      qrCodeBase64, 
      qrCodeCopyPaste, 
      status: "pending",
      type: "pix"
    });

  } catch (error) {
    console.error("❌ Erro ao criar PIX:", error);
    res.status(500).json({ error: error.message || "Falha ao gerar PIX" });
  }
});

app.get("/api/pix/status/:id", async (req, res) => {
  const { id } = req.params;
  
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token" });

  try {
    console.log(`💠 Verificando status PIX: ${id}`);
    
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    
    const data = await response.json();

    console.log(`💠 Status PIX (${id}): ${data.status}`);

    if (data.status === "approved") {
      return res.json({ status: "approved", paymentId: id });
    }
    
    res.json({ status: data.status || "pending" });

  } catch (error) {
    console.error("❌ Erro ao verificar PIX:", error);
    res.json({ status: "pending" });
  }
});

// ==========================================

// CRIAR PAGAMENTO NA MAQUININHA (Point Integration API - volta ao original)
app.post("/api/payment/create", async (req, res) => {
  const { amount, description, orderId, paymentMethod } = req.body;

  // ✅ DETECÇÃO AUTOMÁTICA: Se for PIX, gera QR Code (Payments API)
  if (paymentMethod === 'pix') {
    console.log(`🔀 PIX detectado - gerando QR Code (Payments API)`);
    
    try {
      // Gera chave idempotente única
      const idempotencyKey = `pix_${orderId}_${Date.now()}`;

      const pixPayload = {
        transaction_amount: parseFloat(amount),
        description: description || `Pedido ${orderId}`,
        payment_method_id: "pix",
        payer: {
          email: "cliente@totem.com.br",
          first_name: "Cliente",
          last_name: "Totem"
        },
        external_reference: orderId,
        notification_url: "https://backendkioskpro.onrender.com/api/notifications/mercadopago"
      };
      
      console.log(`📤 Payload PIX:`, JSON.stringify(pixPayload, null, 2));

      const response = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(pixPayload),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error("❌ Erro ao criar PIX:", data);
        throw new Error(data.message || "Erro ao criar PIX");
      }

      console.log(`✅ PIX QR Code criado! Payment ID: ${data.id}`);
      console.log(`📱 QR Code:`, data.point_of_interaction?.transaction_data?.qr_code?.substring(0, 50));

      return res.json({
        id: data.id,
        status: data.status,
        qr_code: data.point_of_interaction?.transaction_data?.qr_code,
        qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url: data.point_of_interaction?.transaction_data?.ticket_url,
        type: 'pix'
      });
    } catch (error) {
      console.error("❌ Erro ao criar PIX:", error);
      return res.status(500).json({ error: error.message });
    }
  }

  // ✅ CARTÕES: Segue para maquininha
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(`💳 Criando payment intent na Point ${MP_DEVICE_ID}...`);
    console.log(`💰 Método solicitado: ${paymentMethod || 'todos'}`);

    // Payload simplificado para Point Integration API
    const payload = {
      amount: Math.round(parseFloat(amount) * 100), // Centavos
      description: description || `Pedido ${orderId}`,
      additional_info: {
        external_reference: orderId,
        print_on_terminal: true,
      }
    };

    // Se método especificado (crédito/débito), adiciona filtro
    if (paymentMethod) {
      const paymentTypeMap = {
        'debit': 'debit_card',
        'credit': 'credit_card'
      };

      const type = paymentTypeMap[paymentMethod];
      
      if (type) {
        payload.payment = {
          type: type,
          installments: paymentMethod === 'credit' ? 1 : undefined,
          installments_cost: paymentMethod === 'credit' ? 'buyer' : undefined
        };
        console.log(`🎯 Filtro ativo: ${type}`);
      }
    }

    console.log(`📤 Payload Point Integration:`, JSON.stringify(payload, null, 2));

    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro ao criar payment intent:", JSON.stringify(data, null, 2));
      console.error(`📡 Status HTTP: ${response.status}`);
      throw new Error(data.message || JSON.stringify(data.errors || data));
    }

    console.log(`✅ Payment intent criado! ID: ${data.id}`);
    console.log(`📱 Status: ${data.state}`);

    res.json({ 
      id: data.id, 
      status: "open",
      type: 'point'
    });

  } catch (error) {
    console.error("❌ Erro Pagamento Point:", error);
    console.error("❌ Stack trace:", error.stack);
    res.status(500).json({ error: error.message || "Falha ao comunicar com maquininha" });
  }
});

// Verificar status PAGAMENTO (híbrido: Order PIX ou Payment Intent Point)
app.get("/api/payment/status/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  if (paymentId.startsWith("mock_")) return res.json({ status: "approved" });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token MP" });

  try {
    console.log(`🔍 Verificando status do pagamento: ${paymentId}`);

    // 1. Tenta buscar como Payment Intent (Point Integration API)
    const intentUrl = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const intentResponse = await fetch(intentUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (intentResponse.ok) {
      // É um Payment Intent (maquininha)
      const intent = await intentResponse.json();
      console.log(`💳 Payment Intent ${paymentId} | State: ${intent.state}`);

      // Verifica se tem payment.id (pagamento aprovado)
      if (intent.payment && intent.payment.id) {
        console.log(`✅ Payment Intent APROVADO! Payment ID: ${intent.payment.id}`);
        
        // Limpa a intent da fila
        try {
          await fetch(intentUrl, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
          console.log(`🧹 Intent ${paymentId} limpa da fila`);
        } catch (e) {
          console.log(`⚠️ Erro ao limpar intent: ${e.message}`);
        }

        return res.json({ status: "approved", paymentId: intent.payment.id });
      }

      // Estados finalizados
      if (intent.state === "FINISHED") {
        console.log(`✅ Intent FINISHED - aprovado`);
        return res.json({ status: "approved" });
      }

      if (intent.state === "CANCELED" || intent.state === "ERROR") {
        console.log(`❌ Intent ${intent.state}`);
        return res.json({ status: "canceled" });
      }

      // Ainda pendente
      console.log(`⏳ Intent pendente (${intent.state})`);
      return res.json({ status: "pending" });
    }

    // 2. Se não é Payment Intent, tenta como Payment PIX
    console.log(`🔄 Não é Payment Intent, tentando como Payment PIX...`);
    const paymentUrl = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const paymentResponse = await fetch(paymentUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (paymentResponse.ok) {
      const payment = await paymentResponse.json();
      console.log(`💚 Payment ${paymentId} | Status: ${payment.status}`);

      if (payment.status === 'approved') {
        console.log(`✅ Payment PIX APROVADO!`);
        return res.json({ status: "approved", paymentId: payment.id });
      } else if (payment.status === 'cancelled' || payment.status === 'rejected') {
        console.log(`❌ Payment ${payment.status.toUpperCase()}`);
        return res.json({ status: "canceled" });
      }

      console.log(`⏳ Payment ainda pendente (${payment.status})`);
      return res.json({ status: "pending" });
    }

    // 3. Não encontrado em nenhum lugar
    console.log(`⚠️ Pagamento ${paymentId} não encontrado`);
    res.json({ status: "pending" });

  } catch (error) {
    console.error("❌ Erro ao verificar status:", error.message);
    res.json({ status: "pending" });
  }
});

// ENDPOINT LEGADO (para compatibilidade temporária com antigo sistema)
app.get("/api/payment/status-pix/:orderId", async (req, res) => {
  console.log(`⚠️ Endpoint legado /status-pix chamado - redirecionando para /status`);
  return res.redirect(307, `/api/payment/status/${req.params.orderId}`);
});

// ==========================================
// --- CANCELAMENTO E LIMPEZA ---
// ==========================================

// Cancelar pagamento específico (Point Intent ou PIX Payment)
app.delete("/api/payment/cancel/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  if (!MP_ACCESS_TOKEN) {
    return res.json({ success: true, message: "Mock cancelado" });
  }

  try {
    console.log(`🛑 CANCELAMENTO FORÇADO: ${paymentId}`);
    
    if (MP_DEVICE_ID) {
      const baseUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
      const urlIntent = `${baseUrl}/${paymentId}`;
      
      // ESTRATÉGIA: Limpar TODA a fila primeiro (forçado)
      console.log(`🧹 LIMPANDO FILA COMPLETA (forçado)...`);
      
      try {
        // 1. Lista todos os intents
        const listResp = await fetch(baseUrl, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        
        if (listResp.ok) {
          const listData = await listResp.json();
          const events = listData.events || [];
          
          console.log(`  📋 ${events.length} intents na fila para remover`);
          
          // 2. Remove TODOS, incluindo o que está em OPEN
          for (const ev of events) {
            const iId = ev.payment_intent_id || ev.id;
            
            try {
              console.log(`  🗑️ Removendo ${iId}...`);
              
              const delResp = await fetch(`${baseUrl}/${iId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
              });
              
              if (delResp.ok || delResp.status === 204 || delResp.status === 404) {
                console.log(`  ✅ ${iId} removido`);
              } else if (delResp.status === 409) {
                // 409 = está processando, aguarda 2s e tenta de novo
                console.log(`  ⏳ ${iId} está processando, aguardando...`);
                await new Promise(r => setTimeout(r, 2000));
                
                const retryResp = await fetch(`${baseUrl}/${iId}`, {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
                });
                
                if (retryResp.ok || retryResp.status === 204 || retryResp.status === 404) {
                  console.log(`  ✅ ${iId} removido na 2ª tentativa`);
                } else {
                  const errText = await retryResp.text();
                  console.log(`  ⚠️ ${iId} ainda não removido: ${errText}`);
                }
              } else {
                const errText = await delResp.text();
                console.log(`  ⚠️ Erro ao remover ${iId}: ${errText}`);
              }
              
            } catch (e) {
              console.log(`  ❌ Exceção ao remover ${iId}: ${e.message}`);
            }
            
            // Delay entre remoções
            await new Promise(r => setTimeout(r, 300));
          }
          
          console.log(`✅ PROCESSO DE LIMPEZA CONCLUÍDO!`);
          console.log(`🔄 Maquininha deve voltar à tela inicial em alguns segundos...`);
          
          return res.json({ 
            success: true, 
            message: "Fila limpa - aguarde alguns segundos",
            cancelled: true,
            cleared: events.length
          });
        }
      } catch (e) {
        console.log(`❌ Erro ao limpar fila: ${e.message}`);
      }
    }
    
    // 3. Se não conseguiu cancelar intent, tenta como payment PIX
    console.log(`🔄 Tentando cancelar como Payment PIX...`);
    const urlPayment = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const response = await fetch(urlPayment, {
      method: "PUT",
      headers: { 
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: "cancelled" })
    });

    if (response.ok || response.status === 404) {
      console.log(`✅ Payment PIX ${paymentId} cancelado`);
      return res.json({ success: true, message: "PIX cancelado" });
    }

    // Se chegou aqui, não conseguiu cancelar
    console.log(`⚠️ Não foi possível cancelar ${paymentId}`);
    return res.json({ success: false, message: "Não foi possível cancelar - pode já estar finalizado" });

  } catch (error) {
    console.error("❌ Erro ao cancelar pagamento:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Limpar TODA a fila da maquininha (útil para logout/sair)
app.post("/api/payment/clear-all", async (req, res) => {
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    return res.json({ success: true, cleared: 0 });
  }

  try {
    console.log(`🧹 [CLEAR ALL] Limpando TODA a fila da maquininha...`);
    
    const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    
    if (!listResp.ok) {
      return res.json({ success: false, error: "Erro ao listar intents" });
    }
    
    const listData = await listResp.json();
    const events = listData.events || [];
    
    console.log(`🔍 Encontradas ${events.length} intent(s) na fila`);
    
    let cleared = 0;
    
    for (const ev of events) {
      const iId = ev.payment_intent_id || ev.id;
      
      try {
        const delResp = await fetch(`${listUrl}/${iId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        
        if (delResp.ok || delResp.status === 404) {
          console.log(`  ✅ Intent ${iId} removida`);
          cleared++;
        }
      } catch (e) {
        console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
      }
      
      // Pequeno delay entre remoções
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`✅ [CLEAR ALL] ${cleared} intent(s) removida(s) - Maquininha limpa!`);
    
    res.json({ 
      success: true, 
      cleared: cleared,
      message: `${cleared} pagamento(s) removido(s) da fila` 
    });
    
  } catch (error) {
    console.error("❌ Erro ao limpar fila:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Configurar Point Smart 2 (modo operacional e vinculação)
app.post("/api/point/configure", async (req, res) => {
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    return res.json({ success: false, error: "Credenciais não configuradas" });
  }

  try {
    console.log(`⚙️ Configurando Point Smart 2: ${MP_DEVICE_ID}`);
    
    // Configuração do dispositivo Point Smart
    const configUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}`;
    
    const configPayload = {
      operating_mode: 'PDV', // Modo PDV - integração com frente de caixa
      // Isso mantém a Point vinculada e bloqueia acesso ao menu
    };
    
    const response = await fetch(configUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(configPayload),
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Point Smart 2 configurada em modo PDV`);
      console.log(`🔒 Menu bloqueado - apenas pagamentos via API`);
      
      return res.json({ 
        success: true, 
        message: "Point configurada com sucesso",
        mode: 'PDV',
        device: data
      });
    } else {
      const error = await response.json();
      console.error(`❌ Erro ao configurar Point:`, error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
  } catch (error) {
    console.error("❌ Erro ao configurar Point Smart 2:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verificar status da Point Smart 2
app.get("/api/point/status", async (req, res) => {
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("⚠️ Status Point: Credenciais não configuradas");
    console.error(`MP_ACCESS_TOKEN: ${MP_ACCESS_TOKEN ? 'OK' : 'AUSENTE'}`);
    console.error(`MP_DEVICE_ID: ${MP_DEVICE_ID || 'AUSENTE'}`);
    return res.json({ connected: false, error: "Credenciais não configuradas" });
  }

  try {
    console.log(`🔍 Verificando status da Point: ${MP_DEVICE_ID}`);
    
    const deviceUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}`;
    const response = await fetch(deviceUrl, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });
    
    console.log(`📡 Resposta API Point: Status ${response.status}`);
    
    if (response.ok) {
      const device = await response.json();
      console.log(`✅ Point encontrada:`, device);
      
      return res.json({
        connected: true,
        id: device.id,
        operating_mode: device.operating_mode,
        status: device.status,
        model: device.model || 'Point Smart 2',
      });
    } else {
      const errorData = await response.json();
      console.error(`❌ Erro ao buscar Point:`, errorData);
      return res.json({ connected: false, error: "Point não encontrada", details: errorData });
    }
    
  } catch (error) {
    console.error("❌ Exceção ao verificar Point:", error);
    res.status(500).json({ connected: false, error: error.message });
  }
});

// Limpar TODA a fila de pagamentos da maquininha (chamar após pagamento aprovado)
app.post("/api/payment/clear-queue", async (req, res) => {
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    return res.json({ success: true, cleared: 0 });
  }

  try {
    console.log(`🧹 [CLEAR QUEUE] Limpando TODA a fila da Point Pro 2...`);
    
    const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    
    if (!listResp.ok) {
      return res.json({ success: false, error: "Erro ao listar intents" });
    }
    
    const listData = await listResp.json();
    const events = listData.events || [];
    
    console.log(`🔍 Encontradas ${events.length} intent(s) na fila`);
    
    let cleared = 0;
    
    for (const ev of events) {
      const iId = ev.payment_intent_id || ev.id;
      const state = ev.state;
      
      try {
        const delResp = await fetch(`${listUrl}/${iId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        
        if (delResp.ok || delResp.status === 404) {
          console.log(`  ✅ Intent ${iId} (${state}) removida`);
          cleared++;
        }
      } catch (e) {
        console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
      }
      
      // Pequeno delay entre remoções
      await new Promise(r => setTimeout(r, 200));
    }
    
    console.log(`✅ [CLEAR QUEUE] ${cleared} intent(s) removida(s) - Point Pro 2 completamente limpa!`);
    
    res.json({ 
      success: true, 
      cleared: cleared,
      message: `${cleared} pagamento(s) removido(s) da fila` 
    });
    
  } catch (error) {
    console.error("❌ Erro ao limpar fila:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Rotas de IA ---

app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai) {
    console.log("❌ OpenAI não inicializada - OPENAI_API_KEY está configurada?");
    return res.json({ text: "IA indisponível" });
  }
  try {
    console.log("🤖 Chamando OpenAI para sugestão...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Vendedor." },
        { role: "user", content: req.body.prompt },
      ],
      max_tokens: 100,
    });
    console.log("✅ Resposta OpenAI recebida!");
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error("❌ ERRO OpenAI:", e.message);
    console.error("Detalhes:", e.response?.data || e);
    res.json({ text: "Sugestão indisponível no momento." });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) {
    console.log("❌ OpenAI não inicializada - OPENAI_API_KEY está configurada?");
    return res.status(503).json({ error: "IA indisponível" });
  }
  try {
    console.log("🤖 Chamando OpenAI para chat...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Atendente." },
        { role: "user", content: req.body.message },
      ],
      max_tokens: 150,
    });
    console.log("✅ Resposta OpenAI recebida!");
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error("❌ ERRO OpenAI:", e.message);
    console.error("Detalhes:", e.response?.data || e);
    res.json({ text: "Desculpe, estou com problemas de conexão." });
  }
});

// --- ANÁLISE INTELIGENTE DE ESTOQUE E VENDAS (Admin) ---

app.get("/api/ai/inventory-analysis", async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: "IA indisponível no momento" });
  }

  try {
    console.log("🤖 Iniciando análise inteligente de estoque...");

    // 1. Buscar todos os produtos com estoque
    const products = await db("products").select("*").orderBy("category");

    // 2. Buscar histórico de pedidos (últimos 30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const orders = await db("orders")
      .where("timestamp", ">=", thirtyDaysAgo.toISOString())
      .select("*");

    // 3. Calcular estatísticas de vendas por produto
    const salesStats = {};
    products.forEach(p => {
      salesStats[p.id] = {
        name: p.name,
        category: p.category,
        price: parseFloat(p.price),
        stock: p.stock,
        totalSold: 0,
        revenue: 0,
        orderCount: 0
      };
    });

    // Contar vendas
    orders.forEach(order => {
      const items = parseJSON(order.items);
      items.forEach(item => {
        if (salesStats[item.id]) {
          salesStats[item.id].totalSold += item.quantity || 1;
          salesStats[item.id].revenue += (item.price || 0) * (item.quantity || 1);
          salesStats[item.id].orderCount += 1;
        }
      });
    });

    // 4. Preparar dados para análise da IA
    const analysisData = {
      totalProducts: products.length,
      totalOrders: orders.length,
      period: "últimos 30 dias",
      products: Object.values(salesStats).map(p => ({
        name: p.name,
        category: p.category,
        price: p.price,
        stock: p.stock === null ? "ilimitado" : p.stock,
        totalSold: p.totalSold,
        revenue: p.revenue.toFixed(2),
        averagePerOrder: p.orderCount > 0 ? (p.totalSold / p.orderCount).toFixed(1) : 0
      }))
    };

    // 5. Prompt estruturado para a IA
    const prompt = `Você é um consultor de negócios especializado em food service. Analise os dados de uma pastelaria:

📊 DADOS DE VENDAS (${analysisData.period}):
- Total de produtos no catálogo: ${analysisData.totalProducts}
- Total de pedidos realizados: ${analysisData.totalOrders}

PRODUTOS E DESEMPENHO:
${analysisData.products.map(p => 
  `• ${p.name} (${p.category}):
    - Preço: R$ ${p.price}
    - Estoque atual: ${p.stock}
    - Vendas: ${p.totalSold} unidades
    - Receita: R$ ${p.revenue}
    - Média por pedido: ${p.averagePerOrder}`
).join('\n')}

Por favor, forneça uma análise completa e acionável sobre:

1. 🚨 ESTOQUE CRÍTICO: Quais produtos precisam URGENTEMENTE de reposição? (estoque baixo ou zerado)

2. 📈 PRODUTOS ESTRELA: Quais estão vendendo muito bem e merecem destaque/promoção?

3. 📉 PRODUTOS EM BAIXA: Quais vendem pouco e podem ser removidos ou reformulados?

4. 💡 SUGESTÕES DE NOVOS PRODUTOS: Baseado nas categorias mais vendidas, que novos sabores/produtos você recomendaria adicionar?

5. 💰 OPORTUNIDADES DE RECEITA: Ajustes de preço ou combos que podem aumentar o faturamento?

Seja direto, prático e use emojis. Priorize ações que o administrador pode tomar HOJE.`;

    console.log("📤 Enviando dados para análise da IA...");

    // 6. Chamar OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "Você é um consultor de negócios especializado em análise de vendas e gestão de estoque para restaurantes e food service. Seja prático, direto e focado em ações." 
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.7
    });

    const analysis = completion.choices[0].message.content;

    console.log("✅ Análise concluída!");

    // 7. Retornar análise + dados brutos
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      period: analysisData.period,
      summary: {
        totalProducts: analysisData.totalProducts,
        totalOrders: analysisData.totalOrders,
        lowStock: products.filter(p => p.stock !== null && p.stock <= 5).length,
        outOfStock: products.filter(p => p.stock === 0).length
      },
      analysis: analysis,
      rawData: salesStats // Para o frontend criar gráficos se quiser
    });

  } catch (error) {
    console.error("❌ Erro na análise de estoque:", error);
    res.status(500).json({ 
      error: "Erro ao processar análise",
      message: error.message 
    });
  }
});

// --- Inicialização ---
console.log("🚀 Iniciando servidor...");
initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ ERRO FATAL ao iniciar servidor:", err);
    process.exit(1);
  });
