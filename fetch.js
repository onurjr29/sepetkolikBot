// package.json içinde "type": "module" ayarlı olmalı
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs/promises";
import pLimit from "p-limit";
import mongoose from "mongoose";

dotenv.config(); // ← Bunu ekle
// ——————————————————————————————————————————————
// 0) MongoDB bağlantısı ve model
// ——————————————————————————————————————————————
const MONGODB_URI = process.env.MONGO_URI || "mongodb://localhost:27017/trendyol";

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFKD")               
    .replace(/[\u0300-\u036f]/g, "") 
    .replace(/[^a-z0-9]+/g, "-")     
    .replace(/^-+|-+$/g, "");        
}


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

}, {
  timestamps: true,
  collection: "products"
});

const Product = mongoose.model("Product", productSchema);

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
  const original = p.price?.originalPrice ?? p.price?.sellingPrice ?? 0;
  const selling  = p.price?.sellingPrice ?? 0;
  const discountPct = original
    ? Math.round(((original - selling) / original) * 100 * 100) / 100
    : 0;

  const imageUrls = Array.isArray(p.images)
    ? p.images
        .map(img => typeof img === "string" ? img : img.url)
        .filter(Boolean)
        .map(u => u.startsWith("http") ? u : `https://cdn.dsmcdn.com${u}`)
    : [];

  // Slug’u hem adı hem de ID’yi birleştirerek oluşturuyoruz
  const slug = slugify(`${p.name}-${p.id}`);

  return {
    anaKategori:         anaKat,
    altKategori:         altKat,
    kategori:            kat,
    id:                  p.id,
    name:                p.name,
    brand:               p.brand?.name ?? "",
    categoryName:        p.categoryName ?? "",
    favoriteCount:       p.socialProof?.favoriteCount?.count ?? 0,
    basketCount:         p.socialProof?.basketCount?.count ?? 0,
    lowestPriceDuration: p.lowestPriceDuration ?? null,
    averageRating:       p.ratingScore?.averageRating ?? 0,
    totalCount:          p.ratingScore?.totalCount ?? 0,
    originalPrice:       original,
    discountedPrice:     selling,
    discountRatio:       p.price?.discountRatio ?? discountPct,
    firstImage:          imageUrls[0] ?? "",
    url:                 `https://www.trendyol.com${p.url}`,

    // Opsiyonel Gelişmiş Alanlar
    variantInformation:  p.variantInformation ?? null,
    promotionBadge:      p.promotionBadge ?? null,
    shippingInformation: p.shippingInformation ?? null,
    attributes:          p.attributes ?? [],

    // ← Yeni eklenen slug alanı
    slug,
  };
}

// ——————————————————————————————————————————————
// 3) Bir kategori için sayfaları çeken fonksiyon
// ——————————————————————————————————————————————
async function fetchCategory(cat) {
  const out = [];
  const genderId = cat.anaKat.includes("ERKEK") ? 2 : 1;

  for (let page = 1; page <= 50; page++) {
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
        continue;  // 404 ise atla, bir sonraki sayfayı dene
      }
      throw err;  // başka bir hata varsa fırlat
    }
  }

  return out;
}


// ——————————————————————————————————————————————
// 4) Tüm kategorileri çek, MongoDB’ye kaydet
// ——————————————————————————————————————————————
async function main() {
  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
  });
  console.log("✅ MongoDB’ye bağlandı.");

  // İsterseniz önce koleksiyonu temizleyin:
  // await Product.deleteMany({});

  const cats = await loadCategories();
  const limit = pLimit(5);
  const batches = await Promise.all(
    cats.map((c) => limit(() => fetchCategory(c)))
  );
  const allProducts = batches.flat();

  if (allProducts.length) {
    await Product.insertMany(allProducts, { ordered: false });
    console.log(`🏁 Toplam ${allProducts.length} ürün MongoDB'ye kaydedildi.`);
  } else {
    console.log("⚠️ Ürün bulunamadı, kayıt yapılmadı.");
  }

  await mongoose.disconnect();
  console.log("🔌 MongoDB bağlantısı kapatıldı.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
