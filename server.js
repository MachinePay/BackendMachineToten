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
console.log(`🗄️ Banco de dados conectado: ${dbType}`);

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
    });
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
  res.send(
    `<h1>Backend KioskPro - VERSÃO CORREÇÃO FINAL (BUSCA POR VALOR) 🚀</h1>`
  );
});

app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", db: dbType })
);

// --- Rotas API ---
app.get("/api/menu", async (req, res) => {
  try {
    const products = await db("products").select("*").orderBy("id");
    res.json(products.map((p) => ({ ...p, price: parseFloat(p.price) })));
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar menu" });
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
    paymentStatus: "paid",
    paymentId: paymentId || null,
  };
  try {
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

// --- INTEGRAÇÃO MERCADO PAGO POINT (Smart - Modo Robustez Total) ---

app.post("/api/payment/create", async (req, res) => {
  const { amount, description, orderId } = req.body;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID)
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });

  try {
    console.log(`💳 Iniciando pagamento de R$ ${amount} na maquininha...`);

    // 1. Tenta limpar a fila antes
    try {
      const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
      const listResp = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const events = listData.events || (listData.id ? [listData] : []);
        if (events.length > 0) {
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
      /* ignore */
    }

    // 2. Cria nova intent com o valor em centavos
    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    // Importante: passamos o valor original também no 'additional_info' para conferência
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Centavos
        description: description || `Pedido ${orderId}`,
        additional_info: {
          external_reference: orderId,
          print_on_terminal: true,
          original_amount: amount, // Guardamos o valor float para comparar depois
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Erro MP Create:", data);
      throw new Error(data.message || "Erro ao criar pagamento");
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

  try {
    // 1. Pergunta para a maquininha
    const urlIntent = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const respIntent = await fetch(urlIntent, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const dataIntent = await respIntent.json();

    console.log(`🔎 Intent Status: ${dataIntent.state}`);

    if (dataIntent.state === "FINISHED" || dataIntent.state === "PROCESSED") {
      return res.json({ status: "approved" });
    }
    if (dataIntent.payment && dataIntent.payment.id) {
      return res.json({ status: "approved" });
    }

    // 2. BUSCA POR VALOR (Já que a Referência vem vazia)
    // Recuperamos o valor esperado da intent (que está em centavos) e convertemos para reais
    const expectedAmount = dataIntent.amount ? dataIntent.amount / 100 : 0;

    if (expectedAmount > 0) {
      console.log(
        `🕵️ Buscando pagamento de R$ ${expectedAmount} nos últimos 10 min...`
      );

      // Busca os últimos 10 pagamentos
      const urlSearch = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=10&range=date_created:NOW-10MINUTES:NOW`;
      const respSearch = await fetch(urlSearch, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const dataSearch = await respSearch.json();
      const payments = dataSearch.results || [];

      // Procura algum pagamento APROVADO com o MESMO VALOR
      const found = payments.find(
        (p) =>
          (p.status === "approved" || p.status === "authorized") &&
          Math.abs(p.transaction_amount - expectedAmount) < 0.01 // Comparação segura de float
      );

      if (found) {
        console.log(`✅ PAGAMENTO ENCONTRADO POR VALOR! ID: ${found.id}`);

        // Destrava a maquininha
        try {
          await fetch(urlIntent, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
          });
        } catch (e) {}

        return res.json({ status: "approved" });
      }
    }

    res.json({ status: "pending" });
  } catch (error) {
    console.error("Erro Status:", error);
    res.json({ status: "pending" });
  }
});

// --- IA ---
app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai) return res.json({ text: "IA indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: req.body.prompt }],
      max_tokens: 100,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    res.json({ text: "Sugestão indisponível." });
  }
});
app.post("/api/ai/chat", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "IA indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: req.body.message }],
      max_tokens: 150,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    res.json({ text: "Erro na IA." });
  }
});

// --- Init ---
initDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`✅ Server running on port ${PORT}`)
  );
});
