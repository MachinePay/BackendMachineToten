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

      // Se aprovado, adiciona ao cache
      if (payment.status === "approved" || payment.status === "authorized") {
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;
        
        confirmedPayments.set(cacheKey, {
          paymentId: payment.id,
          amount: payment.transaction_amount,
          status: payment.status,
          timestamp: Date.now(),
        });

        console.log(`✅ Pagamento ${id} confirmado via IPN e adicionado ao cache! Valor: R$ ${payment.transaction_amount}`);
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

      // Se aprovado, adiciona ao cache
      if (payment.status === "approved" || payment.status === "authorized") {
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;
        
        confirmedPayments.set(cacheKey, {
          paymentId: payment.id,
          amount: payment.transaction_amount,
          status: payment.status,
          timestamp: Date.now(),
        });

        console.log(`✅ Pagamento ${paymentId} confirmado e adicionado ao cache! Valor: R$ ${payment.transaction_amount}`);
      }
    }
  } catch (error) {
    console.error("❌ Erro processando webhook:", error.message);
  }
});

// --- INTEGRAÇÃO MERCADO PAGO POINT (Smart - Versão Final) ---

app.post("/api/payment/create", async (req, res) => {
  const { amount, description, orderId, paymentMethod } = req.body;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(
      `💳 Iniciando pagamento de R$ ${amount} na maquininha ${MP_DEVICE_ID}...`
    );
    console.log(`💰 Método escolhido: ${paymentMethod || 'qualquer'}`);

    // 1. Limpeza de fila preventiva
    try {
      const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
      const listResp = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const events = listData.events || (listData.id ? [listData] : []);
        if (events.length > 0) {
          console.log(
            `🧹 Limpando ${events.length} pedido(s) travado(s) antes de iniciar...`
          );
          for (const ev of events) {
            const iId = ev.payment_intent_id || ev.id;
            await fetch(`${listUrl}/${iId}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
            });
          }
        }
      }
    } catch (e) {
      /* Silencioso */
    }

    // 2. Preparar payload com método de pagamento específico para Point Smart 2
    const payload = {
      amount: Math.round(amount * 100), // Valor em Centavos
      description: description || `Pedido ${orderId}`,
      additional_info: {
        external_reference: orderId,
        print_on_terminal: true,
      }
    };

    // FORÇAR método de pagamento específico (Point Smart 2)
    // Isso impede que a maquininha mostre outras opções
    if (paymentMethod) {
      console.log(`🎯 Point Smart 2 - FORÇANDO método: ${paymentMethod}`);
      
      // Configuração específica por método
      if (paymentMethod === 'pix') {
        payload.payment = {
          type: 'pix',
          // Point Smart 2: força apenas PIX
        };
      } else if (paymentMethod === 'debit') {
        payload.payment = {
          type: 'debit_card',
          installments: 1,
          // Point Smart 2: força apenas débito
        };
      } else if (paymentMethod === 'credit') {
        payload.payment = {
          type: 'credit_card',
          installments: 1,
          installments_cost: 'buyer',
          // Point Smart 2: força apenas crédito
        };
      }
      
      // IMPORTANTE: Point Smart requer operating_mode para forçar método único
      payload.payment.operating_mode = 'PDV'; // Modo PDV força integração
      
      console.log(`✅ Point Smart 2 configurada - Apenas ${payload.payment.type} será aceito`);
    } else {
      console.log(`⚠️ ATENÇÃO: Nenhum método especificado - Point vai mostrar TODAS as opções!`);
    }

    // 3. Cria nova intenção
    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro MP Create:", data);
      throw new Error(data.message || "Erro ao criar pagamento no MP");
    }

    res.json({ id: data.id, status: "open" });
  } catch (error) {
    console.error("Erro Pagamento:", error);
    res.status(500).json({ error: "Falha ao comunicar com maquininha" });
  }
});

app.get("/api/payment/status/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  if (paymentId.startsWith("mock_pay")) return res.json({ status: "approved" });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token MP" });

  try {
    // 0. PRIMEIRO: Verifica a Intent para pegar o valor
    const urlIntent = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const respIntent = await fetch(urlIntent, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const dataIntent = await respIntent.json();
    const intentAmount = dataIntent.amount;

    console.log(`🔎 Intent ID: ${paymentId} | State: ${dataIntent.state} | Valor: R$ ${(intentAmount / 100).toFixed(2)}`);

    // 1. VERIFICA O CACHE PRIMEIRO (webhook pode ter salvado)
    if (intentAmount > 0) {
      const cacheKey = `amount_${intentAmount}`;
      const cached = confirmedPayments.get(cacheKey);
      
      if (cached) {
        console.log(`⚡ PAGAMENTO ENCONTRADO NO CACHE! ID: ${cached.paymentId} (webhook)`);
        
        // Remove do cache
        confirmedPayments.delete(cacheKey);
        
        // Limpa a intent
        try {
          await fetch(urlIntent, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
          console.log(`🧹 Intent ${paymentId} deletada após cache hit`);
        } catch (e) {}
        
        return res.json({ status: "approved", paymentId: cached.paymentId });
      }
    }

    console.log(`💭 Cache miss - consultando API do MP...`);

    // 2. Verifica se há payment.id diretamente na intent (PRIORIDADE)
    if (dataIntent.payment && dataIntent.payment.id) {
      console.log(`✅ Payment ID encontrado na intent: ${dataIntent.payment.id}`);
      
      // FORÇA CANCELAMENTO MÚLTIPLO para garantir que maquininha libere
      console.log(`🔄 Forçando cancelamento da intent na Point Pro 2...`);
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const delResp = await fetch(urlIntent, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
          
          if (delResp.ok || delResp.status === 404) {
            console.log(`✅ Tentativa ${attempt}: Intent ${paymentId} cancelada com sucesso`);
            break;
          } else {
            console.log(`⚠️ Tentativa ${attempt}: Status ${delResp.status}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          }
        } catch (e) {
          console.warn(`❌ Tentativa ${attempt} falhou:`, e.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 500));
        }
      }
      
      // Limpa todas as intents pendentes da maquininha
      try {
        const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
        const listResp = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        
        if (listResp.ok) {
          const listData = await listResp.json();
          const events = listData.events || [];
          
          if (events.length > 0) {
            console.log(`🧹 Limpando ${events.length} intent(s) adicional(is) da fila...`);
            for (const ev of events) {
              const iId = ev.payment_intent_id || ev.id;
              await fetch(`${listUrl}/${iId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
              });
            }
            console.log(`✅ Fila de pagamentos limpa - Point Pro 2 liberada`);
          }
        }
      } catch (e) {
        console.log(`⚠️ Aviso ao limpar fila:`, e.message);
      }
      
      return res.json({ status: "approved", paymentId: dataIntent.payment.id });
    }
    
    // 3. Verifica se a intent tem ID de payment nos detalhes adicionais
    if (dataIntent.additional_info?.external_reference) {
      console.log(`🔍 Buscando por external_reference: ${dataIntent.additional_info.external_reference}`);
    }

    // Verifica estados finalizados - LIMPA AGRESSIVAMENTE
    if (dataIntent.state === "FINISHED" || dataIntent.state === "PROCESSED") {
      console.log(`✅ Intent em estado finalizado: ${dataIntent.state}`);
      console.log(`🚨 ATENÇÃO: Pagamento concluído mas ainda na fila! Limpando TUDO...`);
      
      // Cancelamento múltiplo forçado
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const delResp = await fetch(urlIntent, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
          
          if (delResp.ok || delResp.status === 404) {
            console.log(`✅ Tentativa ${attempt}: Intent ${paymentId} removida`);
            break;
          }
          
          if (attempt < 5) {
            console.log(`⚠️ Tentativa ${attempt} falhou, tentando novamente...`);
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (e) {
          if (attempt < 5) await new Promise(r => setTimeout(r, 300));
        }
      }
      
      // LIMPA TODA A FILA para evitar botão verde voltar ao pagamento
      try {
        const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
        const listResp = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        
        if (listResp.ok) {
          const listData = await listResp.json();
          const events = listData.events || [];
          
          console.log(`🔍 Verificando fila completa: ${events.length} intent(s) encontrada(s)`);
          
          for (const ev of events) {
            const iId = ev.payment_intent_id || ev.id;
            try {
              await fetch(`${listUrl}/${iId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
              });
              console.log(`  🗑️ Intent ${iId} removida da fila`);
            } catch (e) {
              console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
            }
          }
          
          console.log(`✅ TODAS as intents removidas - Botão verde não volta mais ao pagamento!`);
        }
      } catch (e) {
        console.log(`⚠️ Erro ao limpar fila completa:`, e.message);
      }
      
      return res.json({ status: "approved" });
    }

    // 2. BUSCA POR VALOR (Plano de Contingência MELHORADO)
    if (intentAmount > 0) {
      const expectedAmountFloat = intentAmount / 100;
      console.log(
        `🕵️ Buscando pagamento de R$ ${expectedAmountFloat.toFixed(2)} nos últimos 30 min...`
      );

      // Busca nos últimos 30 minutos com mais resultados
      const urlSearch = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=50&range=date_created:NOW-30MINUTES:NOW&status=approved`;
      const respSearch = await fetch(urlSearch, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const dataSearch = await respSearch.json();
      const payments = dataSearch.results || [];

      console.log(`📋 Encontrados ${payments.length} pagamentos APROVADOS recentes`);
      
      // Mostra TODOS os pagamentos para debug
      if (payments.length > 0) {
        console.log(`\n📊 Listando todos os pagamentos encontrados:`);
        payments.slice(0, 10).forEach((p, idx) => {
          const amountInCents = Math.round(p.transaction_amount * 100);
          const match = amountInCents === intentAmount ? "✅ MATCH!" : "";
          console.log(`  ${idx + 1}. ID: ${p.id} | R$ ${p.transaction_amount} (${amountInCents} centavos) | Status: ${p.status} | Método: ${p.payment_method_id || 'N/A'} ${match}`);
        });
        console.log(`\n`);
      }

      // Procura pagamento aprovado com MESMO VALOR
      const found = payments.find((p) => {
        const amountMatch = Math.round(p.transaction_amount * 100) === intentAmount;
        const statusApproved = p.status === "approved" || p.status === "authorized";
        
        return statusApproved && amountMatch;
      });

      if (found) {
        console.log(`✅ PAGAMENTO APROVADO ENCONTRADO! ID: ${found.id} | Valor: R$ ${found.transaction_amount}`);

        // LIMPEZA AGRESSIVA - Point Pro 2 precisa de múltiplas tentativas
        console.log(`🔄 Forçando cancelamento múltiplo na Point Pro 2...`);
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const delResp = await fetch(urlIntent, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
            });
            
            if (delResp.ok || delResp.status === 404) {
              console.log(`✅ Tentativa ${attempt}: Intent ${paymentId} cancelada`);
              break;
            } else {
              console.log(`⚠️ Tentativa ${attempt}: Status ${delResp.status}`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 500));
            }
          } catch (e) {
            console.warn(`❌ Tentativa ${attempt}:`, e.message);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          }
        }
        
        // Limpa TODA a fila de intents pendentes
        try {
          const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
          const listResp = await fetch(listUrl, {
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
          
          if (listResp.ok) {
            const listData = await listResp.json();
            const events = listData.events || [];
            
            if (events.length > 0) {
              console.log(`🧹 Limpando ${events.length} intent(s) da fila Point Pro 2...`);
              for (const ev of events) {
                const iId = ev.payment_intent_id || ev.id;
                try {
                  await fetch(`${listUrl}/${iId}`, {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
                  });
                } catch (e) {
                  /* Continua limpando outras */
                }
              }
              console.log(`✅ Point Pro 2 completamente liberada!`);
            }
          }
        } catch (e) {
          console.log(`⚠️ Aviso ao limpar fila:`, e.message);
        }
        
        console.log(`✅ Maquininha liberada - NÃO cobrará novamente`);
        return res.json({ status: "approved", paymentId: found.id });
      } else {
        console.log(`⏳ Nenhum pagamento aprovado com valor R$ ${expectedAmountFloat.toFixed(2)} encontrado ainda`);
      }
    }

    // Se a intent foi cancelada/erro, limpa e informa ao frontend
    if (dataIntent.state === "CANCELED" || dataIntent.state === "ERROR") {
      console.log(`❌ Intent em estado: ${dataIntent.state}`);
      
      // Tenta limpar mesmo assim para evitar travamentos
      try {
        await fetch(urlIntent, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        console.log(`🧹 Intent cancelada/erro removida da fila`);
      } catch (e) {
        /* Silencioso */
      }
      
      return res.json({ status: "canceled" });
    }

    // Ainda pendente
    res.json({ status: "pending" });
  } catch (error) {
    console.error("❌ Erro ao verificar status:", error.message);
    res.json({ status: "pending" });
  }
});

// Cancelar pagamento manualmente (caso necessário)
app.delete("/api/payment/cancel/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    return res.json({ success: true, message: "Mock cancelado" });
  }

  try {
    console.log(`🛑 Cancelando intent: ${paymentId}`);
    
    const urlIntent = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const response = await fetch(urlIntent, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (response.ok || response.status === 404) {
      console.log(`✅ Intent ${paymentId} cancelada com sucesso`);
      return res.json({ success: true, message: "Pagamento cancelado" });
    } else {
      const error = await response.json();
      console.error(`❌ Erro ao cancelar: ${error.message}`);
      return res.status(400).json({ success: false, error: error.message });
    }
  } catch (error) {
    console.error("❌ Erro ao cancelar pagamento:", error.message);
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
    return res.json({ connected: false, error: "Credenciais não configuradas" });
  }

  try {
    const deviceUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}`;
    const response = await fetch(deviceUrl, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });
    
    if (response.ok) {
      const device = await response.json();
      
      return res.json({
        connected: true,
        id: device.id,
        operating_mode: device.operating_mode,
        status: device.status,
        model: device.model || 'Point Smart 2',
      });
    } else {
      return res.json({ connected: false, error: "Point não encontrada" });
    }
    
  } catch (error) {
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
  if (!openai) return res.json({ text: "IA indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Vendedor." },
        { role: "user", content: req.body.prompt },
      ],
      max_tokens: 100,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    // console.error("Erro OpenAI:", e);
    res.json({ text: "Sugestão indisponível no momento." });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "IA indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Atendente." },
        { role: "user", content: req.body.message },
      ],
      max_tokens: 150,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    // console.error("Erro OpenAI:", e);
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
