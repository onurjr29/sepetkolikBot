// package.json içinde "type": "module" ayarlı olmalı
import dotenv from "dotenv";
dotenv.config();
console.log("🟢 Sync script başlatıldı:", new Date().toLocaleString());

import axios from "axios";
import fs from "fs/promises";
import pLimit from "p-limit";
import { Pool } from "pg";
import cron from "node-cron";
import nodemailer from "nodemailer";

// ——————————————————————————————————————————————
// 0) Postgres bağlantısı ve kategori map yükleme
// ——————————————————————————————————————————————
const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || "5432"),
  user:     process.env.PG_USER,
  password: process.env.PG_PASS,
  database: process.env.PG_DB,
});

async function loadCategoryMap() {
  const sql = `
    SELECT
      c.id AS category_id,
      mc.name AS main_name,
      sc.name AS sub_name,
      c.name  AS cat_name
    FROM categories c
      JOIN sub_categories sc ON sc.id = c.sub_category_id
      JOIN main_categories mc ON mc.id = sc.main_category_id
  `;
  const { rows } = await pool.query(sql);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.main_name}||${r.sub_name}||${r.cat_name}`;
    map.set(key, r.category_id);
  }
  return map;
}

// ——————————————————————————————————————————————
// 1) Helper: trendyol’dan özellik çekme
// ——————————————————————————————————————————————
async function fetchProductAttributes(productId) {
  try {
    const url =
      `https://apigw.trendyol.com/discovery-web-product-detail-service/v2/api/productDetail` +
      `?productId=${productId}&culture=tr-TR`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      timeout: 10000,
    });
    const cats = data.result?.attributeCategories || [];
    return cats.flatMap(cat =>
      (cat.attributes || []).map(a => ({
        category: cat.categoryName,
        name:     a.attributeName,
        value:    a.attributeValueName
      }))
    );
  } catch {
    return [];
  }
}

function slugify(str = "") {
  const s = String(str);
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadCategories() {
  const csv = await fs.readFile("kategori_grup_A.csv", "utf-8");
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map(line => {
      const [anaKat, altKat, kat, webUrl] = line.split(",");
      return {
        anaKat: anaKat.trim().toUpperCase(),
        altKat: altKat.trim(),
        kat:    kat.trim(),
        path:   webUrl.trim(),
      };
    });
}

function mapProduct(p, anaKat, altKat, kat, categoryMap) {
  const absUrl = u => (u && u.startsWith("http")) ? u : u ? `https://cdn.dsmcdn.com${u}` : null;
  const rawImage = Array.isArray(p.images) && p.images.length > 0
    ? p.images[0]
    : p.defaultImageUrl || null;
  const key = `${anaKat}||${altKat}||${kat}`;
  return {
    ana_kategori: anaKat,
    alt_kategori: altKat,
    kategori:     kat,
    category_id:  categoryMap.get(key) || null,
    id:           p.id,
    name:         p.name || "",
    slug:         slugify(`${p.name}-${p.id}`),
    url:          `https://www.trendyol.com${p.url}`,
    brand:        p.brand?.name || "",
    image_url:    rawImage ? absUrl(rawImage) : null,
    variant_information: JSON.stringify(
      (p.variants || []).map(v => ({
        listingId:       v.listingId,
        attributeName:   v.attributeName,
        attributeValue:  v.attributeValue,
        originalPrice:   v.price?.originalPrice   ?? 0,
        discountedPrice: v.price?.discountedPrice ?? 0,
        discountRatio:   v.price?.discountRatio   ?? 0,
        lowestPriceDuration: v.lowestPriceDuration ?? null,
        sameDayShipping: v.sameDayShipping ?? false,
        hasCoupon:       v.hasCollectableCoupon ?? false,
        priceLabels:     v.priceLabels || []
      }))
    ),
    shipping_information: JSON.stringify({
      freeCargo:            p.freeCargo            ?? false,
      rushDeliveryDuration: p.rushDeliveryDuration ?? null
    }),
    favorite_count:   parseInt(p.socialProof?.favoriteCount?.count) || 0,
    basket_count:     parseInt(p.socialProof?.basketCount?.count)   || 0,
    average_rating:   parseFloat(p.ratingScore?.averageRating)      || 0,
    total_count:      parseInt(p.ratingScore?.totalCount)           || 0,
    original_price:   p.price?.originalPrice   ?? 0,
    discounted_price: p.price?.sellingPrice    ?? 0,
    discount_ratio:   p.price?.discountRatio   ?? 0,
    attributes:       JSON.stringify([]),
    promotion_badge:  p.promotionBadge       || "",
    created_at:       new Date(),
    updated_at:       new Date(),
  };
}

async function fetchCategory(cat) {
  const out = [];
  const genderId = cat.anaKat.includes("ERKEK") ? 2 : 1;
  for (let page = 1; page <= 1000; page++) {
    console.log(`📥 Fetching ${cat.kat} page ${page}`);
    const url =
      `https://apigw.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll${cat.path}` +
      `?pi=${page}&culture=tr-TR&userGenderId=${genderId}`;
    try {
      const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, timeout: 10000 });
      const products = res.data.result?.products || [];
      console.log(`✔️ Got ${products.length} items`);
      if (!products.length) break;
      out.push(...products);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`⚠️ Error on ${cat.kat} page ${page}:`, err.message);
      if (err.response?.status === 404) break;
      throw err;
    }
  }
  return out;
}

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
async function sendReport(upserted, updated) {
  const { rows } = await pool.query("SELECT COUNT(*) FROM products");
  const total = rows[0].count;
  const now   = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  const text = `Trendyol Bot Raporu - ${now}\n\nYeni eklenen: ${upserted}\nGüncellenen:    ${updated}\nToplam ürün:    ${total}`;
  await transporter.sendMail({ from: process.env.SMTP_USER, to: process.env.REPORT_EMAIL, subject: "Günlük Trendyol Bot Raporu", text });
}

async function syncProducts() {
  console.log("▶️ syncProducts() çağrıldı:", new Date().toLocaleString());
  const categoryMap = await loadCategoryMap();
  const cats        = await loadCategories();
  console.log(`    📂 ${cats.length} kategori yüklendi.`);
  const limit    = pLimit(5);
  const fetchers = cats.map(cat => limit(() => fetchCategory(cat)));
  const batches  = await Promise.all(fetchers);
  console.log(`    🔄 Toplam ham ürün: ${batches.flat().length}`);

  // 3) flatten ve mapProduct ile eşleştir
  const mappedAll = [];
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    for (const p of batches[i]) {
      mappedAll.push(mapProduct(p, cat.anaKat, cat.altKat, cat.kat, categoryMap));
    }
  }

  // 4) Unique by id
  const uniqueMapped = Array.from(new Map(mappedAll.map(p => [p.id, p])).values());
  console.log(`    🔂 Tekrarsız ürün sayısı: ${uniqueMapped.length}`);

  // 5) Detay fetch
  console.log("    🛠️ Detay attribute fetch’leri başlıyor...");
  await Promise.all(uniqueMapped.map(p => pLimit(5)(async () => { p.attributes = JSON.stringify(await fetchProductAttributes(p.id)); })));
  console.log("    ✅ Detay attribute fetch’leri tamamlandı.");

  // 6) Chunked bulk upsert
  console.log("    💾 Bulk upsert (chunked) başlıyor...");
  const chunkSize = 500;
  const cols = Object.keys(uniqueMapped[0]);
  for (let i = 0; i < uniqueMapped.length; i += chunkSize) {
    const batch = uniqueMapped.slice(i, i + chunkSize);
    const placeholders = batch.map((_, idx) => `(${cols.map((__, j) => `$${idx*cols.length+j+1}`).join(',')})`).join(',');
    const sql = `INSERT INTO products (${cols.join(',')}) VALUES ${placeholders} ON CONFLICT (id) DO UPDATE SET ${cols.map(c => `${c}=EXCLUDED.${c}`).join(',')}`;
    const params = batch.flatMap(Object.values);
    await pool.query(sql, params);
  }
  console.log(`    🏁 Upsert tamam: ${uniqueMapped.length} kayıt işlendi.`);

  // 7) Rapor gönder
  await sendReport(uniqueMapped.filter(p => p).length, 0);
}

async function run() { try { await syncProducts(); } catch (err) { console.error("Sync hata:", err); } }
run();
cron.schedule("0 2 * * *", () => { console.log("Cron sync:", new Date().toLocaleString()); run(); }, { timezone: "Europe/Istanbul" });
