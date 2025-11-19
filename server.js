import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import OpenAI from "openai"; // MUDANÇA: Usando OpenAI agora
import knex from "knex";
import "sqlite3";

const app = express();
const PORT = process.env.PORT || 3001;

// --- Configuração da IA (OpenAI) ---
// A chave deve estar no arquivo .env do backend como OPENAI_API_KEY
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "⚠️ AVISO: A variável OPENAI_API_KEY não foi definida. As funcionalidades de IA não funcionarão."
  );
} else {
  console.log("✅ OpenAI (GPT-4o-mini) configurada com sucesso.");
}

// --- CONFIGURAÇÃO E CONEXÃO COM O BANCO DE DADOS (Knex + SQLite) ---
const db = knex({
  client: "sqlite3",
  connection: {
    filename: path.join(process.cwd(), "data", "kiosk.sqlite"),
  },
  useNullAsDefault: true,
});

// Função para inicializar as tabelas e carregar dados iniciais (SEED)
async function initDatabase() {
  console.log("⏳ Verificando e inicializando tabelas do banco de dados...");

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
      table.json("items").notNullable();
      table.timestamp("completedAt");
    });
  }

  // Carregar menu.json se necessário
  const productCount = await db("products").count("id as count").first();
  if (productCount && productCount.count === 0) {
    console.log("🛠️ Carregando dados iniciais do menu.json...");
    const menuDataPath = path.join(process.cwd(), "data", "menu.json");
    try {
      const rawData = await fs.readFile(menuDataPath, "utf-8");
      const MENU_DATA = JSON.parse(rawData);
      await db("products").insert(MENU_DATA);
      console.log("✅ Dados do menu carregados.");
    } catch (e) {
      console.error(
        "⚠️ Não foi possível carregar dados do menu.json. Ignorando seed.",
        e.message
      );
    }
  }
}

// --- Middlewares ---
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
  })
);
app.use(express.json());

// Log de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Rota Raiz ---
app.get("/", (req, res) => {
  res.send(
    "<h2>Pastelaria Backend Online (OpenAI) 🚀</h2><p>Usando Knex/SQLite para dados.</p>"
  );
});

// ==========================================
// ROTAS DE PRODUTOS
// ==========================================
app.get("/api/menu", async (req, res) => {
  const products = await db("products").select("*").orderBy("id");
  res.json(products);
});

// ==========================================
// ROTAS DE USUÁRIOS
// ==========================================
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
  if (!payload || !payload.cpf) {
    return res.status(400).json({ error: "CPF é obrigatório" });
  }

  const cpfLimpo = String(payload.cpf).replace(/\D/g, "");
  const exists = await db("users").where({ cpf: cpfLimpo }).first();
  if (exists) {
    return res.status(409).json({ error: "CPF já cadastrado" });
  }

  const newUser = {
    id: payload.id || `user_${Date.now()}`,
    name: payload.name || "Sem Nome",
    email: payload.email || "",
    cpf: cpfLimpo,
    historico: JSON.stringify([]),
    pontos: 0,
  };

  try {
    await db("users").insert(newUser);
    res.status(201).json({ ...newUser, historico: [] });
  } catch (err) {
    console.error("Erro ao salvar usuário no DB:", err);
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

// ==========================================
// ROTAS DE PEDIDOS
// ==========================================
app.get("/api/orders", async (req, res) => {
  const orders = await db("orders")
    .where({ status: "active" })
    .select("*")
    .orderBy("timestamp", "asc");
  const parsedOrders = orders.map((o) => ({
    ...o,
    items: JSON.parse(o.items),
    total: parseFloat(o.total),
  }));
  res.json(parsedOrders);
});

app.get("/api/user-orders", async (req, res) => {
  const { userId } = req.query;
  let query = db("orders").orderBy("timestamp", "desc");
  if (userId) {
    query = query.where({ userId });
  }
  const allOrders = await query.select("*");
  const parsedOrders = allOrders.map((o) => ({
    ...o,
    items: JSON.parse(o.items),
    total: parseFloat(o.total),
  }));
  res.json(parsedOrders);
});

app.post("/api/orders", async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.userId || !Array.isArray(payload.items)) {
    return res
      .status(400)
      .json({ error: "Dados inválidos: userId e items são obrigatórios." });
  }

  const id = `order_${Date.now()}`;
  const total =
    typeof payload.total === "number"
      ? payload.total
      : payload.items.reduce((acc, it) => acc + it.price * it.quantity, 0);

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
    await db.transaction(async (trx) => {
      await trx("orders").insert(newOrder);
      const user = await trx("users").where({ id: payload.userId }).first();
      if (user) {
        let historico = JSON.parse(user.historico || "[]");
        historico.push({ ...newOrder, items: payload.items, total });
        await trx("users")
          .where({ id: payload.userId })
          .update({ historico: JSON.stringify(historico) });
      }
    });
    res.status(201).json({ ...newOrder, items: payload.items, total });
  } catch (err) {
    console.error("Erro ao processar pedido no DB:", err);
    res.status(500).json({ error: "Falha ao salvar pedido" });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  const completedAt = new Date().toISOString();
  try {
    const updated = await db("orders").where({ id }).update({
      status: "completed",
      completedAt,
    });
    if (updated === 0)
      return res.status(404).json({ error: "Pedido não encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao finalizar pedido:", err);
    res.status(500).json({ error: "Falha ao finalizar pedido" });
  }
});

// ==========================================
// ROTAS DE INTELIGÊNCIA ARTIFICIAL (OPENAI)
// ==========================================

// Sugestão de Cardápio e Upsell
app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: "Serviço de IA indisponível" });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt é obrigatório" });

  try {
    // Chamada para OpenAI (GPT-4o-mini)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Modelo rápido e barato
      messages: [
        {
          role: "system",
          content:
            "Você é um Chef de Pastelaria especialista em vendas. Responda apenas o texto da sugestão.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 100, // Limita resposta para ser rápido
      temperature: 0.7, // Criatividade média
    });

    const text = completion.choices[0].message.content;
    res.json({ text });
  } catch (error) {
    console.error("❌ Erro na OpenAI (Sugestão):", error);

    // FALLBACK: Se a IA falhar, não trava o toten. Retorna uma sugestão padrão.
    res.status(200).json({
      text: "Que tal adicionar um delicioso caldo de cana geladinho?",
    });
  }
});

// Chatbot
app.post("/api/ai/chat", async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: "Serviço de IA indisponível" });
  }

  const { message } = req.body;
  if (!message)
    return res.status(400).json({ error: "Mensagem é obrigatória" });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é o Chef da 'Pastelaria Kiosk Pro'. 
            Seu tom é amigável, prestativo e brasileiro.
            Responda dúvidas sobre o cardápio e ajude a escolher.
            Seja curto e objetivo (máximo 2 frases).`,
        },
        { role: "user", content: message },
      ],
      max_tokens: 150,
    });

    const text = completion.choices[0].message.content;
    res.json({ text });
  } catch (error) {
    console.error("Erro na OpenAI (Chat):", error);
    res
      .status(500)
      .json({ error: "O Chef está ocupado na cozinha (erro de conexão)." });
  }
});

// --- Inicialização ---
console.log("🚀 Iniciando servidor...");
initDatabase()
  .then(() => {
    console.log("✅ Banco inicializado com sucesso!");
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Servidor rodando na porta ${PORT}`);
      console.log(
        `🗄️ Banco de dados SQLite em: ${path.join(
          process.cwd(),
          "data",
          "kiosk.sqlite"
        )}`
      );
    });
  })
  .catch((err) => {
    console.error("❌ ERRO FATAL ao inicializar o banco de dados:", err);
    process.exit(1);
  });
