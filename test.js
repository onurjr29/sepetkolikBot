async function fetchProductAttributes(productId) {
  try {
    const url = `https://apigw.trendyol.com/discovery-web-product-detail-service/v2/api/productDetail?productId=${productId}&culture=tr-TR`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      timeout: 10000
    });
    const cats = data.result?.attributeCategories || [];
    // Her kategori altındaki özellikleri düz bir listeye çevir
    return cats.flatMap(cat =>
      (cat.attributes || []).map(attr => ({
        category: cat.categoryName,
        name:     attr.attributeName,
        value:    attr.attributeValueName
      }))
    );
  } catch {
    return [];
  }
}
