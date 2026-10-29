
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "dropzone-game";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

const DEFAULT_ITEMS = [
  { id: "sticker", name: "GG Sticker", icon: "🎯", rarity: "common", price: 120 },
  { id: "gloves", name: "Cyber Gloves", icon: "🧤", rarity: "uncommon", price: 650 },
  { id: "katana", name: "Neon Katana", icon: "⚔️", rarity: "rare", price: 2400 },
  { id: "mask", name: "Golden Mask", icon: "🎭", rarity: "epic", price: 8900 },
  { id: "dragon", name: "Void Dragon", icon: "🐉", rarity: "legendary", price: 28000 },
  { id: "crown", name: "Cosmic Crown", icon: "👑", rarity: "legendary", price: 85000 }
];

const DEFAULT_CASES = [
  {
    id: "starter",
    name: "Starter Case",
    icon: "📦",
    desc: "Первый дроп для новичков",
    price: 100,
    drops: [
      { itemId: "sticker", weight: 64 },
      { itemId: "gloves", weight: 25 },
      { itemId: "katana", weight: 9 },
      { itemId: "mask", weight: 1.7 },
      { itemId: "dragon", weight: 0.28 },
      { itemId: "crown", weight: 0.02 }
    ]
  },
  {
    id: "neon",
    name: "Neon Case",
    icon: "💎",
    desc: "Больше редких предметов",
    price: 700,
    drops: [
      { itemId: "sticker", weight: 20 },
      { itemId: "gloves", weight: 43 },
      { itemId: "katana", weight: 27 },
      { itemId: "mask", weight: 8.5 },
      { itemId: "dragon", weight: 1.45 },
      { itemId: "crown", weight: 0.05 }
    ]
  },
  {
    id: "mythic",
    name: "Mythic Case",
    icon: "🌌",
    desc: "Редкие коллекционные предметы",
    price: 2500,
    drops: [
      { itemId: "gloves", weight: 12 },
      { itemId: "katana", weight: 48 },
      { itemId: "mask", weight: 29 },
      { itemId: "dragon", weight: 10 },
      { itemId: "crown", weight: 1 }
    ]
  }
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) return false;

  const [salt, expectedHex] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");

  return expected.length === actual.length &&
    crypto.timingSafeEqual(actual, expected);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature) return null;

    const expected = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(body)
      .digest();

    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)) return null;

    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    );

    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function getToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);

  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)dz_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function cookieHeader(token, clear = false) {
  return `dz_session=${clear ? "" : encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : 604800}`;
}

function publicUser(user) {
  return {
    username: user.username,
    balance: user.balance,
    inventory: user.inventory
      .map(id => id)
  };
}

function cleanString(value, max = 60) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validPrice(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100000000;
}

function weightedItem(db, caseData) {
  const available = caseData.drops
    .filter(drop =>
      db.items.some(item => item.id === drop.itemId) &&
      Number.isFinite(drop.weight) &&
      drop.weight > 0
    );

  const total = available.reduce((sum, drop) => sum + drop.weight, 0);
  if (!total) return null;

  let roll = crypto.randomInt(0, 1000000000) / 1000000000 * total;

  for (const drop of available) {
    roll -= drop.weight;
    if (roll < 0) return db.items.find(item => item.id === drop.itemId);
  }

  return db.items.find(item => item.id === available[available.length - 1].itemId);
}

function defaultDatabase() {
  return {
    users: [],
    items: DEFAULT_ITEMS.map(item => ({
      ...item,
      priceHistory: [{ price: item.price, at: Date.now() }]
    })),
    cases: DEFAULT_CASES,
    transactions: [],
    marketUpdatedAt: Date.now()
  };
}

function ensurePriceHistory(db) {
  let changed = false;
  const now = Date.now();
  for (const item of db.items) {
    if (!Array.isArray(item.priceHistory) || item.priceHistory.length === 0) {
      item.priceHistory = [
        { price: Math.max(1, Math.floor(Number(item.price) * 0.9)), at: now - 86400000 },
        { price: Number(item.price) || 1, at: now }
      ];
      changed = true;
    } else {
      const last = item.priceHistory[item.priceHistory.length - 1];
      if (!last || Number(last.price) !== Number(item.price)) {
        item.priceHistory.push({ price: Number(item.price) || 1, at: now });
        item.priceHistory = item.priceHistory.slice(-100);
        changed = true;
      }
    }
  }
  return changed;
}

function advanceMarket(db) {
  const now = Date.now();
  let changed = ensurePriceHistory(db);
  const lastUpdate = Number(db.marketUpdatedAt) || 0;
  if (now - lastUpdate < 60000) return changed;

  for (const item of db.items) {
    const previous = Math.max(1, Math.floor(Number(item.price) || 1));
    // Мягкая симуляция роста: колебания цены с небольшим положительным уклоном.
    const movement = (crypto.randomInt(-150, 351) / 10000);
    const next = Math.max(1, Math.min(100000000, Math.round(previous * (1 + movement))));
    item.price = next;
    if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
    item.priceHistory.push({ price: next, at: now });
    item.priceHistory = item.priceHistory.slice(-100);
    if (next !== previous) changed = true;
  }
  db.marketUpdatedAt = now;
  return true || changed;
}

async function readDatabase(store) {
  let db = await store.get("database", { type: "json" });

  if (!db) {
    db = defaultDatabase();
    await store.setJSON("database", db);
  }

  if (!Array.isArray(db.users) ||
      !Array.isArray(db.items) ||
      !Array.isArray(db.cases) ||
      !Array.isArray(db.transactions)) {
    throw new Error("Database format is invalid");
  }

  return db;
}

async function writeDatabase(store, db) {
  await store.setJSON("database", db);
}

export default async function handler(request) {
  if (!ADMIN_PASSWORD || !SESSION_SECRET) {
    return json({
      error: "Настрой ADMIN_PASSWORD и SESSION_SECRET в Netlify Environment Variables"
    }, 500);
  }

  const url = new URL(request.url);
  let action = url.searchParams.get("action") || "";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Allow": "GET, POST, OPTIONS"
      }
    });
  }

  const store = getStore(STORE_NAME);

  try {
    if (method === "GET" && action === "state") {
      const db = await readDatabase(store);
      if (advanceMarket(db)) await writeDatabase(store, db);
      const token = getToken(request);
      const session = verifyToken(token);

      const user = session?.role === "user"
        ? db.users.find(entry => entry.id === session.sub)
        : null;

      return json({
        items: db.items,
        cases: db.cases,
        user: user ? publicUser(user) : null,
        isAdmin: session?.role === "admin"
      });
    }

    if (method !== "POST") {
      return json({ error: "Метод не поддерживается" }, 405);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Некорректный JSON" }, 400);
    }

    if (!action && typeof body.action === "string") action = body.action;
    const actionAliases = {
      open_case: "open-case", buy_item: "buy-item", sell_item: "sell-item",
      admin_login: "admin-login", admin_create_item: "create-item",
      admin_create_case: "create-case", admin_delete_item: "delete-item",
      admin_delete_case: "delete-case", admin_update_item: "update-item",
      admin_update_case: "update-case", add_balance: "add-balance"
    };
    action = actionAliases[action] || action.replaceAll("_", "-");

    if (action === "register") {
      const username = cleanString(body.username, 20);
      const password = typeof body.password === "string" ? body.password : "";

      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username) ||
          password.length < 8 || password.length > 100) {
        return json({
          error: "Имя: 3–20 символов. Пароль: 8–100 символов"
        }, 400);
      }

      const db = await readDatabase(store);
      if (db.users.some(user =>
        user.username.toLowerCase() === username.toLowerCase()
      )) {
        return json({ error: "Это имя уже занято" }, 409);
      }

      const user = {
        id: randomId("user"),
        username,
        passwordHash: hashPassword(password),
        balance: 1000,
        inventory: [],
        createdAt: Date.now()
      };

      db.users.push(user);
      await writeDatabase(store, db);

      const token = sign({
        sub: user.id,
        role: "user",
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000
      });

      return json({
        user: publicUser(user)
      }, 201, { "Set-Cookie": cookieHeader(token) });
    }

    if (action === "login") {
      const username = cleanString(body.username, 20);
      const password = typeof body.password === "string" ? body.password : "";

      const db = await readDatabase(store);
      const user = db.users.find(entry =>
        entry.username.toLowerCase() === username.toLowerCase()
      );

      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json({ error: "Неверное имя или пароль" }, 401);
      }

      const token = sign({
        sub: user.id,
        role: "user",
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000
      });

      return json({
        user: publicUser(user)
      }, 200, { "Set-Cookie": cookieHeader(token) });
    }

    if (action === "admin-login") {
      const password = typeof body.password === "string" ? body.password : "";
      if (password !== ADMIN_PASSWORD) {
        return json({ error: "Неверный пароль администратора" }, 401);
      }

      const token = sign({
        sub: "admin",
        role: "admin",
        exp: Date.now() + 4 * 60 * 60 * 1000
      });

      return json({
        isAdmin: true
      }, 200, { "Set-Cookie": cookieHeader(token) });
    }

    const session = verifyToken(getToken(request));
    if (!session) {
      return json({ error: "Войди в аккаунт" }, 401);
    }

    const db = await readDatabase(store);
    const user = session.role === "user"
      ? db.users.find(entry => entry.id === session.sub)
      : null;

    if (action === "logout") {
      return json({ ok: true }, 200, {
        "Set-Cookie": cookieHeader("", true)
      });
    }

    if (action === "open-case") {
      if (!user) return json({ error: "Нет доступа" }, 403);

      const caseData = db.cases.find(entry => entry.id === body.caseId);
      if (!caseData) return json({ error: "Кейс не найден" }, 404);
      if (user.balance < caseData.price) {
        return json({ error: "Не хватает монет" }, 400);
      }

      const item = weightedItem(db, caseData);
      if (!item) return json({ error: "В кейсе нет предметов" }, 400);

      user.balance -= caseData.price;
      user.inventory.push(item.id);
      db.transactions.push({
        id: randomId("tx"),
        userId: user.id,
        type: "case",
        itemId: item.id,
        caseId: caseData.id,
        createdAt: Date.now()
      });

      await writeDatabase(store, db);
      return json({
        item,
        user: publicUser(user)
      });
    }

    if (action === "buy-item") {
      if (!user) return json({ error: "Нет доступа" }, 403);

      const item = db.items.find(entry => entry.id === body.itemId);
      if (!item) return json({ error: "Предмет не найден" }, 404);
      if (user.balance < item.price) {
        return json({ error: "Не хватает монет" }, 400);
      }

      user.balance -= item.price;
      user.inventory.push(item.id);
      db.transactions.push({
        id: randomId("tx"),
        userId: user.id,
        type: "buy",
        itemId: item.id,
        createdAt: Date.now()
      });

      await writeDatabase(store, db);
      return json({ user: publicUser(user) });
    }

    if (action === "sell-item") {
      if (!user) return json({ error: "Нет доступа" }, 403);

      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= user.inventory.length) {
        return json({ error: "Предмет не найден" }, 404);
      }

      const itemId = user.inventory[index];
      const item = db.items.find(entry => entry.id === itemId);
      if (!item) return json({ error: "Предмет больше недоступен" }, 404);

      const payout = Math.floor(item.price * 0.6);
      user.inventory.splice(index, 1);
      user.balance += payout;
      db.transactions.push({
        id: randomId("tx"),
        userId: user.id,
        type: "sell",
        itemId: item.id,
        createdAt: Date.now()
      });

      await writeDatabase(store, db);
      return json({ user: publicUser(user), payout });
    }

    if (session.role !== "admin") {
      return json({ error: "Только администратор может это сделать" }, 403);
    }

    if (action === "update-item") {
      const item = db.items.find(entry => entry.id === body.id);
      const price = body.price;

      if (!item || !validPrice(price)) {
        return json({ error: "Проверь предмет и цену" }, 400);
      }

      item.price = price;
      if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
      item.priceHistory.push({ price, at: Date.now() });
      item.priceHistory = item.priceHistory.slice(-100);
    } else if (action === "delete-item") {
      const id = cleanString(body.id, 100);
      const requestedName = cleanString(body.name, 45).toLocaleLowerCase();
      let target = db.items.find(item => item.id === id);

      // Если интерфейс прислал устаревший ID, используем точное имя,
      // но только когда совпадение единственное.
      if (!target && requestedName) {
        const matches = db.items.filter(
          item => item.name.trim().toLocaleLowerCase() === requestedName
        );
        if (matches.length === 1) target = matches[0];
      }

      if (!target) {
        return json({ error: "Предмет не найден. Обнови страницу и попробуй снова" }, 404);
      }

      const deletedId = target.id;
      db.items = db.items.filter(item => item.id !== deletedId);
      db.cases.forEach(c => {
        c.drops = c.drops.filter(drop => drop.itemId !== deletedId);
      });
      db.users.forEach(entry => {
        entry.inventory = entry.inventory.filter(itemId => itemId !== deletedId);
      });
    } else if (action === "update-case") {
      const c = db.cases.find(entry => entry.id === body.id);
      if (!c || !validPrice(body.price)) {
        return json({ error: "Проверь кейс и цену" }, 400);
      }

      c.price = body.price;
    } else if (action === "delete-case") {
      const id = cleanString(body.id, 100);
      const requestedName = cleanString(body.name, 45).toLocaleLowerCase();
      let target = db.cases.find(c => c.id === id);

      // Резервный поиск по точному названию, если ID в интерфейсе устарел.
      if (!target && requestedName) {
        const matches = db.cases.filter(
          c => c.name.trim().toLocaleLowerCase() === requestedName
        );
        if (matches.length === 1) target = matches[0];
      }

      if (!target) {
        return json({ error: "Кейс не найден. Обнови страницу и попробуй снова" }, 404);
      }

      const deletedId = target.id;
      db.cases = db.cases.filter(c => c.id !== deletedId);
    } else if (action === "create-item") {
      const name = cleanString(body.name, 45);
      const icon = cleanString(body.icon || "💎", 8);
      const rarity = cleanString(body.rarity, 20);
      const price = body.price;

      if (!name || !["common", "uncommon", "rare", "epic", "legendary"].includes(rarity)
          || !validPrice(price)) {
        return json({ error: "Проверь данные предмета" }, 400);
      }

      const item = {
        id: randomId("item"), name, icon, rarity, price,
        priceHistory: [{ price, at: Date.now() }]
      };
      db.items.push(item);

      const weights = {
        common: 45, uncommon: 25, rare: 12, epic: 3, legendary: 0.35
      };

      db.cases.forEach(c => {
        c.drops.push({ itemId: item.id, weight: weights[rarity] });
      });
    } else if (action === "create-case") {
      const name = cleanString(body.name, 45);
      const icon = cleanString(body.icon || "📦", 8);
      const desc = cleanString(body.desc || "Коллекционный кейс", 100);
      const price = body.price;

      if (!name || !validPrice(price)) {
        return json({ error: "Проверь название и цену" }, 400);
      }

      const weights = {
        common: 45, uncommon: 25, rare: 12, epic: 3, legendary: 0.35
      };

      db.cases.push({
        id: randomId("case"),
        name, icon, desc, price,
        drops: db.items.map(item => ({
          itemId: item.id,
          weight: weights[item.rarity] || 1
        }))
      });
    } else if (action === "add-balance") {
      const target = db.users.find(entry => entry.username === body.username);
      const amount = body.amount;

      if (!target || !validPrice(amount)) {
        return json({ error: "Проверь пользователя и сумму" }, 400);
      }

      target.balance += amount;
    } else {
      return json({ error: "Неизвестное действие" }, 404);
    }

    await writeDatabase(store, db);
    return json({
      ok: true,
      items: db.items,
      cases: db.cases
    });
  } catch (error) {
    console.error("DROPZONE function error:", error);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
}