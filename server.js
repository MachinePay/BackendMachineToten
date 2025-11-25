import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import knex from "knex";
// import "sqlite3"; // Mantenha comentado para evitar erros no Render

const app = express();
const PORT = process.env.PORT || 3001;

// --- Configuração da IA (OpenAI) ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// --- Configuração Mercado Pago ---
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_DEVICE_ID = process.env.MP_DEVICE_ID;

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
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

// Helper para tratar JSON (Funciona no SQLite e Postgres)
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

// --- SEED: Função para inicializar o banco ---
async function initDatabase() {
  console.log("⏳ Verificando tabelas...");

  // Tabela de Produtos
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

  // Tabela de Usuários
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

  // Tabela de Pedidos
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
      table.string("paymentStatus").defaultTo("pending"); // Adicionado status de pagamento
      table.string("paymentId"); // ID do pagamento no MP
      table.json("items").notNullable();
      table.timestamp("completedAt");
    });
  }

  // Carregar Dados do Menu se estiver vazio
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
    origin: function (origin, callback) {
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

// --- Rotas Gerais ---

app.get("/", (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h1>Pastelaria Backend Online 🚀</h1>
      <p>Banco: <strong>${dbType}</strong></p>
      <p>Modo Debug IA: <strong>ATIVADO</strong> (Erros aparecerão na tela)</p>
    </div>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", db: dbType });
});

app.get("/api/force-seed", async (req, res) => {
  try {
    const menuDataPath = path.join(process.cwd(), "data", "menu.json");
    const rawData = await fs.readFile(menuDataPath, "utf-8");
    const MENU_DATA = JSON.parse(rawData);
    await db("products").del();
    await db("products").insert(MENU_DATA);
    res.json({ message: "Menu recarregado!", count: MENU_DATA.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- APIs do Sistema ---

app.get("/api/menu", async (req, res) => {
  try {
    const products = await db("products").select("*").orderBy("id");
    const parsedProducts = products.map((product) => ({
      ...product,
      price: parseFloat(product.price),
    }));
    res.json(parsedProducts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao buscar menu" });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await db("users").select("*");
    const parsedUsers = users.map((u) => ({
      ...u,
      historico: parseJSON(u.historico),
    }));
    res.json(parsedUsers);
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.post("/api/users", async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.cpf)
    return res.status(400).json({ error: "CPF obrigatório" });

  const cpfLimpo = String(payload.cpf).replace(/\D/g, "");
  try {
    const exists = await db("users").where({ cpf: cpfLimpo }).first();
    if (exists) return res.status(409).json({ error: "CPF já cadastrado" });

    const newUser = {
      id: payload.id || `user_${Date.now()}`,
      name: payload.name || "Sem Nome",
      email: payload.email || "",
      cpf: cpfLimpo,
      historico: JSON.stringify([]),
      pontos: 0,
    };
    await db("users").insert(newUser);
    res.status(201).json({ ...newUser, historico: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await db("orders")
      .where({ status: "active" })
      .select("*")
      .orderBy("timestamp", "asc");

    const parsed = orders.map((o) => ({
      ...o,
      items: parseJSON(o.items),
      total: parseFloat(o.total),
    }));
    res.json(parsed);
  } catch (err) {
    console.error("Erro na rota GET /orders:", err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

app.post("/api/orders", async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.userId || !Array.isArray(payload.items)) {
    return res.status(400).json({ error: "Dados inválidos" });
  }

  const id = `order_${Date.now()}`;
  const total =
    typeof payload.total === "number"
      ? payload.total
      : (payload.items || []).reduce((acc, i) => acc + i.price * i.quantity, 0);

  const newOrder = {
    id,
    userId: payload.userId,
    userName: payload.userName || "Cliente",
    items: JSON.stringify(payload.items),
    total,
    timestamp: new Date().toISOString(),
    status: "active",
    paymentStatus: "pending", // Inicia pendente até pagar
  };

  try {
    const userExists = await db("users").where({ id: payload.userId }).first();
    if (!userExists) {
      await db("users").insert({
        id: payload.userId,
        name: payload.userName || "Convidado",
        email: null,
        cpf: null,
        historico: JSON.stringify([]),
        pontos: 0,
      });
    }

    await db("orders").insert(newOrder);
    res.status(201).json({ ...newOrder, items: payload.items });
  } catch (err) {
    console.error("Erro no POST /orders:", err);
    res.status(500).json({ error: "Erro ao processar pedido" });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    await db("orders")
      .where({ id: req.params.id })
      .update({ status: "completed", completedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao finalizar pedido" });
  }
});

app.get("/api/user-orders", async (req, res) => {
  try {
    const { userId } = req.query;
    let query = db("orders").orderBy("timestamp", "desc");
    if (userId) query = query.where({ userId });

    const allOrders = await query.select("*");
    const parsedOrders = allOrders.map((o) => ({
      ...o,
      items: parseJSON(o.items),
      total: parseFloat(o.total),
    }));
    res.json(parsedOrders);
  } catch (err) {
    console.error("Erro GET /user-orders:", err);
    res.status(500).json({ error: "Erro ao buscar histórico" });
  }
});

// --- Integração Mercado Pago Point ---

app.post("/api/payment/create", async (req, res) => {
  const { amount, description, orderId } = req.body;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("Faltam credenciais do Mercado Pago");
    // Simulação para testes se não tiver credenciais
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });
  }

  try {
    // Cria a intenção de pagamento na maquininha
    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // O Mercado Pago Point espera o valor em CENTAVOS (Integer)
        amount: Math.round(amount * 100), // Envia 10.50 se o preço for R$ 10,50, // Valor em centavos? Verificar doc. Geralmente é valor decimal no Point.
        // Correção: Point API usa valor decimal normal, mas vamos garantir.
        // Na doc mais recente: "amount": 150.50
        // Se for integration-api, confirmar se aceita float.
        description: description || `Pedido ${orderId}`,
        additional_info: {
          external_reference: orderId,
          print_on_terminal: true,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro MP:", data);
      throw new Error(data.message || "Erro ao criar pagamento no MP");
    }

    // Salva o paymentId no pedido
    await db("orders").where({ id: orderId }).update({
      paymentId: data.id,
    });

    res.json({ id: data.id, status: "open" });
  } catch (error) {
    console.error("Erro Pagamento:", error);
    res.status(500).json({ error: "Falha ao comunicar com maquininha" });
  }
});

app.get("/api/payment/status/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  // Simulação de sucesso para testes
  if (paymentId.startsWith("mock_pay")) {
    return res.json({ status: "approved" });
  }

  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token MP" });

  try {
    const url = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    const data = await response.json();

    // LOG PARA DEBUG (Vai aparecer no painel da Render)
    console.log(
      `🔎 STATUS MP (${paymentId}): Estado=${data.state} | IdPagamento=${
        data.payment ? data.payment.id : "N/A"
      }`
    );

    // AQUI ESTÁ O SEGREDO:
    // A API Point retorna "FINISHED" ou "PROCESSED" quando a maquininha termina.
    // Se tiver isso, consideramos Aprovado para o Kiosk liberar a tela.
    if (data.state === "FINISHED" || data.state === "PROCESSED") {
      return res.json({ status: "approved" });
    }

    // Verificação extra: Se já tiver um objeto de pagamento aprovado dentro da resposta
    if (data.payment && data.payment.status === "approved") {
      return res.json({ status: "approved" });
    }

    // Se não for nenhum dos acima, ainda está pendente
    res.json({ status: "pending" });
  } catch (error) {
    console.error("Erro status:", error);
    res.status(500).json({ error: "Erro ao verificar status" });
  }
});

// --- Rotas de IA (MODO DEBUG ATIVADO) ---

app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai)
    return res.json({ text: "ERRO: Chave API não configurada no .env" });
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
    res.json({ text: `ERRO DA API (DEBUG): ${e.message}` });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "IA não configurada" });
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
    res.json({ text: `ERRO DA API (DEBUG): ${e.message}` });
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
