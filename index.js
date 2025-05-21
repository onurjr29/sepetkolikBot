// package.json içinde "type": "module" ayarlı olmalı
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs/promises";
import pLimit from "p-limit";
import mongoose from "mongoose";
import cron from "node-cron";
import nodemailer from "nodemailer";

dotenv.config(); // ← Bunu ekle
// ——————————————————————————————————————————————
// 0) MongoDB bağlantısı ve model
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


await mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS:         45000,
});
console.log("✅ MongoDB’ye bağlandı.");


const productSchema = new mongoose.Schema({
  anaKategori:         { type: String, required: true },
  altKategori:         { type: String, required: true },
  kategori:            { type: String, required: true },
  id:                  { type: Number, unique: true, index: true },
  name:                { type: String },
  brand:               { type: String },
  categoryName:        { type: String },
  favoriteCount:       { type: Number },
  basketCount:         { type: Number },
  lowestPriceDuration: { type: Number, default: null },
  averageRating:       { type: Number },
  totalCount:          { type: Number },
  originalPrice:       { type: Number },
  discountedPrice:     { type: Number },
  discountRatio:       { type: Number },
  firstImage:          { type: String },
  url:                 { type: String },
  variantInformation:  { type: mongoose.Schema.Types.Mixed, default: null },
  promotionBadge:      { type: String },
  shippingInformation: { type: mongoose.Schema.Types.Mixed, default: null },
  attributes:          { type: Array, default: [] },
  slug: { type: String, required: true },

}, {
  timestamps: true,
  collection: "products"
});

const Product = mongoose.model("Product", productSchema);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});


// ——————————————————————————————————————————————
// 1) Kategori listesini oku
// ——————————————————————————————————————————————
async function loadCategories() {
  const csv = await fs.readFile("kategori_grup_A.csv", "utf-8");
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [anaKat, altKat, kat, webUrl] = line.split(",");
      return {
        anaKat: anaKat.trim().toUpperCase(),
        altKat: altKat.trim(),
        kat: kat.trim(),
        path: webUrl.trim(),
      };
    });
}

// ——————————————————————————————————————————————
// 2) Tek bir product’ı “simplified model”e çevir
// ——————————————————————————————————————————————
function mapProduct(p, anaKat, altKat, kat) {
  const absUrl = u => u.startsWith("http") ? u : `https://cdn.dsmcdn.com${u}`;
  return {
    anaKategori: anaKat,
    altKategori: altKat,
    kategori:    kat,
    id:          p.id,
    name:        p.name || "",
    slug:        slugify(`${p.name}-${p.id}`),
    url:         `https://www.trendyol.com${p.url}`,
    images:      (p.images||[]).map(absUrl),
    brand: p.brand?.name || null,
    
    // Variants içinden tüm varyant bilgilerini alıyoruz
    variantInformation: p.variants?.map(v => ({
      listingId:           v.listingId,
      attributeName:       v.attributeName,
      attributeValue:      v.attributeValue,
      originalPrice:       v.price?.originalPrice   ?? 0,
      discountedPrice:     v.price?.discountedPrice ?? 0,
      discountRatio:       v.price?.discountRatio   ?? 0,
      lowestPriceDuration: v.lowestPriceDuration   ?? null,
      sameDayShipping:     v.sameDayShipping        ?? false,
      hasCollectableCoupon:v.hasCollectableCoupon   ?? false,
      priceLabels:         v.priceLabels            || []
    })) || [],
    // Kargo bilgilerini shippingInformation içine koyuyoruz
    shippingInformation: {
      freeCargo:           p.freeCargo            ?? false,
      rushDeliveryDuration:p.rushDeliveryDuration ?? null
    },
    // Sosyal kanıt & puan
    favoriteCount:       parseInt(p.socialProof?.favoriteCount?.count) || 0,
    basketCount:         parseInt(p.socialProof?.basketCount?.count)   || 0,
    averageRating:       parseFloat(p.ratingScore?.averageRating)     || 0,
    totalCount:          parseInt(p.ratingScore?.totalCount)          || 0,
    // Fiyat
    originalPrice:       p.price?.originalPrice   ?? 0,
    discountedPrice:     p.price?.sellingPrice    ?? 0,
    discountRatio:       p.price?.discountRatio   ?? 0,
    // Burada attributes boş geliyor; bir sonraki adımda dolduracağız
    attributes:          [],
    // Dilersen sections, badges, promotions gibi diğer alanları da ekleyebilirsin
  };
}



// ——————————————————————————————————————————————
// 3) Bir kategori için sayfaları çeken fonksiyon
// ——————————————————————————————————————————————
async function fetchCategory(cat) {
  const out = [];
  const genderId = cat.anaKat.includes("ERKEK") ? 2 : 1;

  for (let page = 1; page <= 1000; page++) {
    const url = `https://apigw.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll${cat.path}?pi=${page}&culture=tr-TR&userGenderId=${genderId}`;

    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        timeout: 10000,
      });

      const products = res.data.result?.products || [];
      if (!products.length) {
        console.log(`  → ${cat.kat} sayfa ${page}: ürün kalmadı, kategori sonlandırılıyor.`);
        break;  // boşsa kategoriyi bitir
      }

      for (const p of products) {
        out.push(mapProduct(p, cat.anaKat, cat.altKat, cat.kat));
      }
      console.log(`  → ${cat.kat} sayfa ${page}: ${products.length} ürün`);
      await new Promise((r) => setTimeout(r, 500));

    } catch (err) {
      if (err.response?.status === 404) {
        console.warn(`  ⚠️ ${cat.kat} sayfa ${page} bulunamadı, atlanıyor.`);
        break;  // 404 ise atla, bir sonraki sayfayı dene
      } 
      throw err;  // başka bir hata varsa fırlat
    }
  }

  return out;
}


// ——————————————————————————————————————————————
// 4) Tüm kategorileri çek, MongoDB’ye kaydet
// ——————————————————————————————————————————————

transporter.verify().then(() => {
  console.log("✅ SMTP sunucusuna bağlanıldı.");
}).catch(err => {
  console.warn("⚠️ SMTP doğrulama hatası:", err);
});

async function sendReport(upsertedCount, modifiedCount) {
  const totalCount = await Product.countDocuments();
  const now = new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });

  const text = `
📋 Trendyol Bot Raporu
────────────────────────
Tarih & Saat: ${now}
Yeni eklenen ürün: ${upsertedCount}
Güncellenen ürün: ${modifiedCount}
Veritabanında toplam ürün: ${totalCount}
────────────────────────
`;

  await transporter.sendMail({
    from: `"Trendyol Bot" <${process.env.SMTP_USER}>`,
    to:   process.env.REPORT_EMAIL,
    subject: "Günlük Trendyol Bot Raporu",
    text
  });

  console.log("✉️ Rapor maili gönderildi.");
}


async function syncProducts() {
  const cats    = await loadCategories();
  const limit   = pLimit(5);
  const batches = await Promise.all(cats.map(c => limit(() => fetchCategory(c))));
  const all     = batches.flat();
  if (!all.length) return console.warn("⚠️ Ürün bulunamadı.");

  // 1) Tekilleştir
  const uniqueProducts = Array.from(
    new Map(all.map(p => [p.id, p])).values()
  );

  // 2) Detail API’dan özellikleri çek
  const detailLimit = pLimit(5);
  const withAttrs = await Promise.all(uniqueProducts.map(p =>
    detailLimit(async () => {
      p.attributes = await fetchProductAttributes(p.id);
      return p;
    })
  ));

  // 3) bulkWrite için doğrudan withAttrs kullan
  const ops = withAttrs.map(p => ({
    updateOne: {
      filter: { id: p.id },      // BURASI artık doğru
      update:  { $set: p },
      upsert:  true,
    }
  }));

  const result = await Product.bulkWrite(ops, { ordered: false });
  const upsertedCount = result.upsertedCount ?? result.nUpserted ?? 0;
  const modifiedCount = result.modifiedCount ?? result.nModified ?? 0;

  console.log(`🏁 Upsert: yeni ${upsertedCount}, güncellenen ${modifiedCount}`);
  await sendReport(upsertedCount, modifiedCount);
}



async function run() {
  try {
    await syncProducts();
  } catch (e) {
    console.error("❌ Senkron hata:", e);
  }
}

// Uygulama ayağa kalkınca hemen bir kere çalışsın
run();
 
// Her gece 02:00’de çalışsın
cron.schedule("0 2 * * *", () => {
  console.log("⏰ Cron ile senkron başladı:", new Date().toLocaleString());
  run();
}, { timezone: "Europe/Istanbul" });