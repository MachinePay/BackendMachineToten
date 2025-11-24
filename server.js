import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import knex from "knex";
// import "sqlite3"; // Mantenha comentado ou removido para o Render

const app = express();
const PORT = process.env.PORT || 3001;

// --- Configuração da IA (OpenAI) ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
// Detecta automaticamente: Se tem DATABASE_URL (Render), usa Postgres. Senão, usa SQLite.
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

// Identificação visual do banco para a rota raiz
const dbType = process.env.DATABASE_URL
  ? "PostgreSQL (Render)"
  : "SQLite (Local)";
console.log(`🗄️ Banco de dados conectado: ${dbType}`);

// --- SEED: Função para inicializar o banco ---
async function initDatabase() {
  console.log("⏳ Verificando tabelas...");

  // 1. Tabela de Produtos
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

  // 2. Tabela de Usuários
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

  // 3. Tabela de Pedidos
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
      table.json("items").notNullable();
      table.timestamp("completedAt");
    });
  }

  // 4. Carregar Dados do Menu (Correção Crítica para Postgres)
  const result = await db("products").count("id as count").first();
  // O Postgres retorna count como String ("0"), o SQLite como Number (0).
  // Convertendo para Number, garantimos que funcione em ambos.
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
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    credentials: true,
  })
);
app.use(express.json());

// --- Rotas ---

// Rota Raiz (Atualizada para mostrar o status real)
app.get("/", (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h1>Pastelaria Backend Online 🚀</h1>
      <p>Status: <strong>Online</strong></p>
      <p>Banco de Dados: <strong>${dbType}</strong></p>
      <p>IA: <strong>${
        openai ? "Ativa (GPT-4o-mini)" : "Desativada"
      }</strong></p>
    </div>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", db: dbType });
});

// Rota de Emergência (Útil se o banco continuar vazio)
app.get("/api/force-seed", async (req, res) => {
  try {
    const menuDataPath = path.join(process.cwd(), "data", "menu.json");
    const rawData = await fs.readFile(menuDataPath, "utf-8");
    const MENU_DATA = JSON.parse(rawData);

    // Cuidado: Limpa e insere de novo
    await db("products").del();
    await db("products").insert(MENU_DATA);

    res.json({
      message: "Menu recarregado com sucesso!",
      count: MENU_DATA.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- APIs do Sistema ---

app.get("/api/menu", async (req, res) => {
  try {
    const products = await db("products").select("*").orderBy("id");
    res.json(products);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao buscar menu" });
  }
});

app.get("/api/users", async (req, res) => {
  const users = await db("users").select("*");
  const parsedUsers = users.map((u) => ({
    ...u,
    historico: JSON.parse(u.historico || "[]"),
  }));
  res.json(parsedUsers);
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
  const orders = await db("orders")
    .where({ status: "active" })
    .select("*")
    .orderBy("timestamp", "asc");
  const parsed = orders.map((o) => ({
    ...o,
    items: JSON.parse(o.items),
    total: parseFloat(o.total),
  }));
  res.json(parsed);
});

app.post("/api/orders", async (req, res) => {
  const payload = req.body;
  const id = `order_${Date.now()}`;
  // Calcula total ou usa o enviado
  const total =
    typeof payload.total === "number"
      ? payload.total
      : (payload.items || []).reduce((acc, i) => acc + i.price * i.quantity, 0);

  const newOrder = {
    id,
    userId: payload.userId,
    userName: payload.userName || "",
    items: JSON.stringify(payload.items),
    total,
    timestamp: new Date().toISOString(),
    status: "active",
  };

  try {
    await db("orders").insert(newOrder);
    // Opcional: Atualizar histórico do usuário aqui se necessário
    res.status(201).json({ ...newOrder, items: payload.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar pedido" });
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

// --- Rotas de IA ---

app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai) return res.json({ text: "Experimente nosso Pastel de Carne!" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Seja um garçom vendedor." },
        { role: "user", content: req.body.prompt },
      ],
      max_tokens: 100,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error(e);
    res.json({ text: "Hoje recomendo o Pastel de Queijo!" });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) return res.status(503).json({ error: "IA Indisponível" });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é o atendente da Pastelaria Kiosk Pro. Seja curto e amigável.",
        },
        { role: "user", content: req.body.message },
      ],
      max_tokens: 150,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro na IA" });
  }
});

// --- Inicialização ---
initDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
  });
});
