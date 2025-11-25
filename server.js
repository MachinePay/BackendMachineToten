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
  const count = result ? Number(result.count) : 0;

  if (count === 0) {
    console.log("🛠️ Banco vazio! Carregando menu.json...");
    const menuDataPath = path.join(process.cwd(), "data", "menu.json");
    try {
      const rawData = await fs.readFile(menuDataPath, "utf-8");
      const MENU_DATA = JSON.parse(rawData);
      await db("products").insert(MENU_DATA);
      console.log("✅ Menu carregado com sucesso!");
    } catch (e) {
      console.error("⚠️ Erro ao carregar menu.json:", e.message);
    }
  } else {
    console.log(`✅ O banco já contém ${count} produtos.`);
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
      <p>Status: <strong>OPERACIONAL</strong></p>
    </div>
  `);
});

app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", db: dbType })
);

// --- Rotas da API (Menu, Usuários, Pedidos) ---

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
  const { userId, userName, items, total, paymentMethod, paymentId } = req.body;

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

// --- INTEGRAÇÃO MERCADO PAGO POINT (Smart) ---

app.post("/api/payment/create", async (req, res) => {
  const { amount, description, orderId } = req.body;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(
      `💳 Iniciando pagamento de R$ ${amount} na maquininha ${MP_DEVICE_ID}...`
    );

    // 1. Tenta limpar a fila de intents anteriores para evitar erro 409
    try {
      const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
      const listResp = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const events = listData.events || [];
        if (events.length > 0) {
          console.log(`🧹 Limpando ${events.length} pedido(s) travado(s)...`);
          for (const ev of events) {
            await fetch(`${listUrl}/${ev.payment_intent_id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
            });
          }
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Aviso: Não foi possível limpar a fila (pode já estar vazia)."
      );
    }

    // 2. Cria a nova intenção de pagamento
    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Valor em Centavos
        description: description || `Pedido ${orderId}`,
        additional_info: {
          external_reference: orderId, // Importante para a verificação dupla
          print_on_terminal: true,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro MP:", data);
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
    // 1. Verifica o status da "Intenção" (Comando na maquininha)
    const urlIntent = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const respIntent = await fetch(urlIntent, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const dataIntent = await respIntent.json();

    // Cenário A: A maquininha já avisou que terminou
    if (dataIntent.state === "FINISHED" || dataIntent.state === "PROCESSED") {
      console.log("✅ Aprovado via Intent State (FINISHED)");
      return res.json({ status: "approved" });
    }
    // Cenário B: A maquininha já mandou o ID do pagamento
    if (dataIntent.payment && dataIntent.payment.id) {
      console.log("✅ Aprovado via Payment ID na Intent");
      return res.json({ status: "approved" });
    }

    // 2. VERIFICAÇÃO DUPLA (Pulo do Gato)
    // Se a maquininha estiver lenta (ON_TERMINAL) mas o dinheiro já entrou, buscamos pelo ID do pedido
    if (
      dataIntent.additional_info &&
      dataIntent.additional_info.external_reference
    ) {
      const orderRef = dataIntent.additional_info.external_reference;
      const urlSearch = `https://api.mercadopago.com/v1/payments/search?external_reference=${orderRef}&status=approved`;

      const respSearch = await fetch(urlSearch, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const dataSearch = await respSearch.json();

      if (dataSearch.results && dataSearch.results.length > 0) {
        console.log("✅ Aprovado via Busca de Pagamento (Reference Check)!");
        return res.json({ status: "approved" });
      }
    }

    console.log(`⏳ Status Pendente: ${dataIntent.state}`);
    res.json({ status: "pending" });
  } catch (error) {
    console.error("Erro Status:", error);
    // Retorna pending para não quebrar o loop do frontend
    res.json({ status: "pending" });
  }
});

// --- Rotas de IA ---

app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai)
    return res.json({ text: "IA indisponível (Sem créditos ou chave)" });
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
    console.error("Erro OpenAI:", e);
    res.json({ text: "Sugestão indisponível no momento." });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "IA indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Atendente curto." },
        { role: "user", content: req.body.message },
      ],
      max_tokens: 150,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error("Erro OpenAI:", e);
    res.json({ text: "Desculpe, estou com problemas de conexão." });
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
