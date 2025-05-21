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
// 0) Postgres bağlantısı
// ——————————————————————————————————————————————
const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || "5432"),
  user:     process.env.PG_USER,
  password: process.env.PG_PASS,
  database: process.env.PG_DB,
});

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

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ——————————————————————————————————————————————
// 2) Kategorileri CSV’den oku
// ——————————————————————————————————————————————
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

// ——————————————————————————————————————————————
// 3) Ürünü basitleştir ve flatten et
// ——————————————————————————————————————————————
function mapProduct(p, anaKat, altKat, kat) {
  const absUrl = u => u.startsWith("http") ? u : `https://cdn.dsmcdn.com${u}`;
  return {
    ana_kategori: anaKat,
    alt_kategori: altKat,
    kategori:     kat,
    id:           p.id,
    name:         p.name || "",
    slug:         slugify(`${p.name}-${p.id}`),
    url:          `https://www.trendyol.com${p.url}`,
    brand:        p.brand?.name || "",
    variant_information: JSON.stringify(
      (p.variants || []).map(v => ({
        listingId:           v.listingId,
        attributeName:       v.attributeName,
        attributeValue:      v.attributeValue,
        originalPrice:       v.price?.originalPrice   ?? 0,
        discountedPrice:     v.price?.discountedPrice ?? 0,
        discountRatio:       v.price?.discountRatio   ?? 0,
        lowestPriceDuration: v.lowestPriceDuration   ?? null,
        sameDayShipping:     v.sameDayShipping        ?? false,
        hasCoupon:           v.hasCollectableCoupon   ?? false,
        priceLabels:         v.priceLabels            || []
      }))
    ),
    shipping_information: JSON.stringify({
      freeCargo:            p.freeCargo            ?? false,
      rushDeliveryDuration: p.rushDeliveryDuration ?? null
    }),
    favorite_count:     parseInt(p.socialProof?.favoriteCount?.count)  || 0,
    basket_count:       parseInt(p.socialProof?.basketCount?.count)    || 0,
    average_rating:     parseFloat(p.ratingScore?.averageRating)       || 0,
    total_count:        parseInt(p.ratingScore?.totalCount)            || 0,
    original_price:     p.price?.originalPrice   ?? 0,
    discounted_price:   p.price?.sellingPrice    ?? 0,
    discount_ratio:     p.price?.discountRatio   ?? 0,
    attributes:         JSON.stringify([]),
    promotion_badge:    p.promotionBadge         || "",
    created_at:         new Date(),
    updated_at:         new Date(),
  };
}


// ——————————————————————————————————————————————
// 4) Bir kategori sayfasını çek
// ——————————————————————————————————————————————
async function fetchCategory(cat) {
  const out = [];
  const genderId = cat.anaKat.includes("ERKEK") ? 2 : 1;

  for (let page = 1; page <= 2; page++) {
    console.log(`📥 Fetching category “${cat.kat}” — page ${page}`);  // ← log page here

    const url =
      `https://apigw.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll${cat.path}` +
      `?pi=${page}&culture=tr-TR&userGenderId=${genderId}`;

    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        timeout: 10000,
      });

      const products = res.data.result?.products || [];
      console.log(`✔️  Got ${products.length} items`);  // ← log how many items returned

      if (!products.length) {
        console.log(`🔚 No more products on page ${page}, stopping.`);
        break;
      }

      for (const p of products) {
        out.push(mapProduct(p, cat.anaKat, cat.altKat, cat.kat));
      }

      // small delay to avoid rate-limit
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`⚠️ Error on page ${page}:`, err.message);
      if (err.response?.status === 404) break;
      throw err;
    }
  }

  return out;
}


// ——————————————————————————————————————————————
// 5) Mail ayarları (cron rapor için)
// ——————————————————————————————————————————————
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});

async function sendReport(upserted, updated) {
  const { rows } = await pool.query("SELECT COUNT(*) FROM products");
  const total = rows[0].count;
  const now   = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  const text = `
Trendyol Bot Raporu - ${now}

Yeni eklenen: ${upserted}
Güncellenen:    ${updated}
Toplam ürün:    ${total}
`;
  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to:      process.env.REPORT_EMAIL,
    subject: "Günlük Trendyol Bot Raporu",
    text
  });
}

// ——————————————————————————————————————————————
// 6) Sync işlemi: bulk upsert
// ——————————————————————————————————————————————
async function syncProducts() {
  console.log("▶️ syncProducts() çağrıldı:", new Date().toLocaleString());

  // 1) Kategori listesini oku
  const cats = await loadCategories();
  console.log(`    📂 ${cats.length} kategori yüklendi.`);

  // 2) Her kategori için sayfaları çek
  const limit    = pLimit(5);
  const fetchers = cats.map(cat => limit(async () => {
    console.log(`   🚀 fetchCategory başladı: ${cat.kat}`);
    const res = await fetchCategory(cat);
    console.log(`   ✅ fetchCategory bitti: ${cat.kat}, ${res.length} ürün döndü.`);
    return res;
  }));
  const batches = await Promise.all(fetchers);
  const all     = batches.flat();
  console.log(`    🔄 Toplam ham ürün: ${all.length}`);

  if (!all.length) {
    console.warn("⚠️ Ürün bulunamadı, çıkılıyor.");
    return;
  }

  // 3) Unique
  const unique   = Array.from(new Map(all.map(p => [p.id, p])).values());
  console.log(`    🔂 Tekrarsız ürün sayısı: ${unique.length}`);

  // 4) Detay attribute fetch’leri
  console.log("    🛠️ Detay attribute fetch’leri başlıyor...");
  const detailLimit = pLimit(5);
  await Promise.all(unique.map(p => detailLimit(async () => {
    p.attributes = JSON.stringify(await fetchProductAttributes(p.id));
  })));
  console.log("    ✅ Detay attribute fetch’leri tamamlandı.");

  // 5) Bulk upsert
  console.log("    💾 Upsert işlemi başlıyor...");
  let upserted = 0, updated = 0;
  for (const p of unique) {
    const keys    = Object.keys(p);
    const vals    = keys.map((_, i) => `$${i + 1}`).join(",");
    const updates = keys.map(k => `${k}=EXCLUDED.${k}`).join(",");
    const text    =
      `INSERT INTO products (${keys.join(",")}) VALUES (${vals})
       ON CONFLICT (id) DO UPDATE SET ${updates}`;
    const res     = await pool.query(text, Object.values(p));
    if (res.command === "INSERT") upserted++;
    else if (res.command === "UPDATE") updated++;
  }
  console.log(`    🏁 Upsert tamam: ${upserted} yeni, ${updated} güncellendi.`);

  // 6) Rapor gönder
  await sendReport(upserted, updated);
}


// ——————————————————————————————————————————————
// 7) Çalıştır ve cron
// ——————————————————————————————————————————————
async function run() {
  try {
    await syncProducts();
  } catch (err) {
    console.error("Sync hata:", err);
  }
}

// Başlangıçta bir kez
run();

// Her gece 02:00’de
cron.schedule("0 2 * * *", () => {
  console.log("Cron sync:", new Date().toLocaleString());
  run();
}, { timezone: "Europe/Istanbul" });
