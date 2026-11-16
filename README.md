# Alaçam Dağıtım Toptan Katalog

Sitenin tek veri kaynağı Shopify Admin API’deki **Toptan Katalog** (`160658587954`). Normal mağazanın herkese açık ürün uç noktaları, perakende JSON yedeği, CSV fiyat yükleme, yayımlama ve sıfırlama akışları kaldırılmıştır. Katalog bağlantısına sahip herkes fiyatları görebilir.

## Veri ve açılış

Sunucu seçilen etkin kataloğun yayınındaki aktif ürünleri, yayımlanmış varyantları, fiyat listesini, miktar kurallarını ve fiyat kademelerini okur. Görünen her varyantın fiyatı ve sipariş kuralı bu fiyat listesinden gelmelidir; eksik fiyat için standart ürün fiyatına dönülmez. Varyantların barkod, stok, görsel, seçenek ve açıklama bilgileri de kataloğun ürün yayını üzerinden alınır. Karşılaştırma fiyatı varsa aynı katalog fiyat kaydından gelir. Katalog okuma akışı Shopify’da veri değiştirmez; yalnızca müşteri tarafından gönderilen sipariş talepleri taslak sipariş olarak yazılır.

Tamamlanmış ve doğrulanmış katalog, mevcut Private Blob deposunda `catalog/shopify-v3/<catalog-id>/snapshot.json` olarak tek kayıtta saklanır. `/api/catalog` ziyaretçiye bu kaydı verir. Ziyaretçinin tarayıcısı Shopify sayfalarını tek tek indirmez. Kayıt bir dakikadan eskiyse `waitUntil` ile sunucuda arka plan yenilemesi başlatılır; mevcut kayıt bekletilmeden döner. Depodaki koşullu güncelleme kilidi eşzamanlı ziyaretçilerin ayrı taramalar başlatmasını engeller. Yenileme tamamlanmadan yeni kayıt yayımlanmaz; başarısız işlem son doğrulanmış kaydı bozmaz.

Tarayıcı yalnızca bu kaynaktan gelen kataloğu IndexedDB’de saklar ve tekrar açılışta hemen gösterir. ETag ile değişiklik kontrol edilir; değişmeyen yanıtta ürün gövdesi yeniden indirilmez. Sunucuda güncelleme varsa arayüz arka planda sonucu alır; ekran üzerinde her seferinde ürün sayma/yükleme akışı yoktur. İnternet veya Shopify hatasında son toptan kaydın tarihi ve uyarı gösterilir. İlk kurulumda henüz sunucu kaydı yoksa ilk eşitlemenin tamamlanması gerekir.

## Vercel ayarları

- `SHOPIFY_SHOP=dx0nin-1q.myshopify.com`
- `SHOPIFY_CATALOG_ID=160658587954`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` — Secret türünde
- Bağlı Private Blob deposunun `BLOB_READ_WRITE_TOKEN` veya `BLOB_STORE_ID` değeri

Uygulama aynı Shopify kuruluşunda mağazaya kurulmuş olmalıdır. `read_products` ve `read_publications` gereklidir. `read_companies` şirket bağlantısını kontrol etmek için kullanılabilir. Talep oluşturma için `write_draft_orders`, sonucu belirsiz gönderimleri sorgulamak için `read_draft_orders` gerekir. Erişim belirteci sunucuda otomatik yenilenir; istemciye anahtar veya belirteç gönderilmez.

Vercel dağıtımı Node.js 22 ve Fluid Compute kullanır. `/api/catalog` için 300 saniye süre ayrılmıştır; eşitleme kendi 240 saniyelik sınırını uygular. `/api/shopify-status` uygulama ve katalog erişimini kontrol eder. Sayfa açılışları yenilemeyi tetikler; ayrıca bağımsız bir zamanlanmış iş tanımlanmamıştır.

## Yerel çalışma ve doğrulama

Node.js 22 ile `npm ci`. Ortam ayarlarını yükledikten sonra `SHOPIFY_CACHE_DIRECTORY` için `public` dışında bir mutlak dizin seçerek `npm run dev` çalıştırın. Yerel adres `http://127.0.0.1:4173/`. Shopify ayarları yoksa perakende örnek veri gösterilmez.

`npm run sync`, aynı Shopify eşitlemesini sunucu kaydına uygular; CSV veya mağaza dosyası kabul etmez. `node --test test/*.test.cjs` ile bağlantı, kaynak doğruluğu, depolama, eşzamanlı yenileme ve ETag testleri çalıştırılır.

## Sipariş talebi

“Talebe ekle” ürünleri biriktirir. Müşteri firma adı, ad soyad ve e-posta bilgilerini girip “Talep oluştur” ile `/api/draft-request` uç noktasına gönderir; telefon ve not isteğe bağlıdır. Talep Shopify **Siparişler → Taslaklar** bölümüne `Dijital Katalog` / `Sipariş Talebi` etiketleriyle kaydolur. Firma, yetkili, iletişim bilgileri, kaynak katalog ve benzersiz talep kodu taslağın notunda bulunur. Sipariş tamamlanmaz, ödeme alınmaz, stok rezerve edilmez ve fatura gönderilmez. Giriş doğrulaması olmadan bir Shopify müşteri veya şirket hesabına bağlanmaz.

Sunucu gönderimde yalnızca seçilen varyantların fiyatlarını, stok/yayın durumunu ve kataloğun miktar kurallarını Shopify’dan yeniden okur. Tam ürün taraması yapılmaz. Fiyat kademesi sunucuda hesaplanır, ekranda onaylanan birim fiyatıyla karşılaştırılır; değişiklik varsa talep gönderilmeden kullanıcıya bildirilir. Satırın `priceOverride` değeri bu katalog fiyatıyla TRY olarak yazılır. Otomatik indirim uygulanmaz; vergi ve teslimatın son kontrolü Shopify’daki taslak üzerinde yapılır. En fazla 50 farklı ürün gönderilir.

Her talebin UUID kodu, gönderilmeden önce sekme deposuna yazılır. Private Blob’da koşullu oluşturulan kalıcı niyet kaydı eşzamanlı gönderimlerin aynı kodla ikinci taslağı oluşturmasını engeller. Sonuç belirsizse mutasyon tekrar edilmez; aynı kodun durum kontrolü Shopify’daki benzersiz etiketten taslağı arar. Kayıt bulunamıyorsa kullanıcıya kontrol için talep kodu gösterilir. Kalıcı niyet kaydında iletişim bilgileri tutulmaz; içerik özeti, durum ve talep numarası bulunur. Aynı kaynak IP’den on dakikada en fazla 10 yeni deneme kabul edilir. Uç nokta aynı kökenli JSON POST kabul eder; istemciye Shopify anahtarı verilmez.

Kaynaklar: [Shopify fiyat listesi](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList), [taslak sipariş oluşturma](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate), [Vercel arka plan işlemleri](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package), [Private Blob](https://vercel.com/docs/vercel-blob/private-storage).
