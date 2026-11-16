# Alaçam Dağıtım Toptan Katalog

Sitenin tek veri kaynağı Shopify Admin API’deki **Toptan Katalog** (`160658587954`). Normal mağazanın herkese açık ürün uç noktaları, perakende JSON yedeği, CSV fiyat yükleme, yayımlama ve sıfırlama akışları kaldırılmıştır. Katalog bağlantısına sahip herkes fiyatları görebilir.

## Veri ve açılış

Sunucu seçilen etkin kataloğun yayınındaki aktif ürünleri, yayımlanmış varyantları, fiyat listesini, miktar kurallarını ve fiyat kademelerini okur. Görünen her varyantın fiyatı ve sipariş kuralı bu fiyat listesinden gelmelidir; eksik fiyat için standart ürün fiyatına dönülmez. Varyantların barkod, stok, görsel, seçenek ve açıklama bilgileri de kataloğun ürün yayını üzerinden alınır. Karşılaştırma fiyatı varsa aynı katalog fiyat kaydından gelir. Shopify’a yazma yapılmaz.

Tamamlanmış ve doğrulanmış katalog, mevcut Private Blob deposunda `catalog/shopify-v3/<catalog-id>/snapshot.json` olarak tek kayıtta saklanır. `/api/catalog` ziyaretçiye bu kaydı verir. Ziyaretçinin tarayıcısı Shopify sayfalarını tek tek indirmez. Kayıt bir dakikadan eskiyse `waitUntil` ile sunucuda arka plan yenilemesi başlatılır; mevcut kayıt bekletilmeden döner. Depodaki koşullu güncelleme kilidi eşzamanlı ziyaretçilerin ayrı taramalar başlatmasını engeller. Yenileme tamamlanmadan yeni kayıt yayımlanmaz; başarısız işlem son doğrulanmış kaydı bozmaz.

Tarayıcı yalnızca bu kaynaktan gelen kataloğu IndexedDB’de saklar ve tekrar açılışta hemen gösterir. ETag ile değişiklik kontrol edilir; değişmeyen yanıtta ürün gövdesi yeniden indirilmez. Sunucuda güncelleme varsa arayüz arka planda sonucu alır; ekran üzerinde her seferinde ürün sayma/yükleme akışı yoktur. İnternet veya Shopify hatasında son toptan kaydın tarihi ve uyarı gösterilir. İlk kurulumda henüz sunucu kaydı yoksa ilk eşitlemenin tamamlanması gerekir.

## Vercel ayarları

- `SHOPIFY_SHOP=dx0nin-1q.myshopify.com`
- `SHOPIFY_CATALOG_ID=160658587954`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` — Secret türünde
- Bağlı Private Blob deposunun `BLOB_READ_WRITE_TOKEN` veya `BLOB_STORE_ID` değeri

Uygulama aynı Shopify kuruluşunda mağazaya kurulmuş olmalıdır. `read_products` ve `read_publications` gereklidir. `read_companies` şirket bağlantısını kontrol etmek için kullanılabilir. Erişim belirteci sunucuda otomatik yenilenir; istemciye anahtar veya belirteç gönderilmez.

Vercel dağıtımı Node.js 22 ve Fluid Compute kullanır. `/api/catalog` için 300 saniye süre ayrılmıştır; eşitleme kendi 240 saniyelik sınırını uygular. `/api/shopify-status` uygulama ve katalog erişimini kontrol eder. Sayfa açılışları yenilemeyi tetikler; ayrıca bağımsız bir zamanlanmış iş tanımlanmamıştır.

## Yerel çalışma ve doğrulama

Node.js 22 ile `npm ci`. Ortam ayarlarını yükledikten sonra `SHOPIFY_CACHE_DIRECTORY` için `public` dışında bir mutlak dizin seçerek `npm run dev` çalıştırın. Yerel adres `http://127.0.0.1:4173/`. Shopify ayarları yoksa perakende örnek veri gösterilmez.

`npm run sync`, aynı Shopify eşitlemesini sunucu kaydına uygular; CSV veya mağaza dosyası kabul etmez. `node --test test/*.test.cjs` ile bağlantı, kaynak doğruluğu, depolama, eşzamanlı yenileme ve ETag testleri çalıştırılır.

## Sepet

Sepet ve not tarayıcıda tutulur. Minimum alım, artış adedi ve miktara bağlı fiyatlar Shopify kataloğundan uygulanır. WhatsApp düğmesi müşterinin göndereceği talep taslağını açar. Shopify taslak sipariş oluşturma izni tanımlanmış olsa da otomatik taslak sipariş gönderimi henüz etkin değildir. Giriş doğrulaması olmadan bir Shopify şirket hesabına sipariş atanmaz.

Kaynaklar: [Shopify fiyat listesi](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList), [Vercel arka plan işlemleri](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package), [Private Blob](https://vercel.com/docs/vercel-blob/private-storage).
