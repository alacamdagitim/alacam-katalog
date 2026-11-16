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

Shopify sorguları istemci içinde sıraya alınır; yanıtın `throttleStatus` bütçesi ve `restoreRate` değerine göre beklenir. Seçilen bir varyantın fiyatı için 100 kayıtlık sorgu yerine tek kayıt istenir. `THROTTLED` / HTTP 429 ile çalıştırılmadan reddedilen işlemler sınırlı süre içinde yeniden denenir; belirsiz bir mutasyon tekrar çalıştırılmaz. Taslak oluşturmadan önceki okuma hatası, taslak oluşturulmuş gibi değerlendirilmez: form açık kalır ve normal “Talep oluştur” düğmesi kullanılabilir. `write_draft_orders` izni gönderim öncesinde kontrol edilir.

Her talebin UUID kodu, gönderilmeden önce sekme deposuna yazılır. Private Blob’da koşullu oluşturulan kalıcı niyet kaydı eşzamanlı gönderimlerin aynı kodla ikinci taslağı oluşturmasını engeller. Sonuç belirsizse mutasyon tekrar edilmez; aynı kodla otomatik kurtarma Shopify’daki benzersiz etiketten taslağı arar. Kullanıcıya ayrı durum kontrolü veya talep kopyalama adımı sunulmaz. Kalıcı niyet kaydında iletişim bilgileri tutulmaz; içerik özeti, durum ve talep numarası bulunur. Uç nokta aynı kökenli JSON POST kabul eder; istemciye Shopify anahtarı verilmez.

Onay ekranındaki “Yeni talep oluştur” düğmesi kataloğa döndürür; arama/filtreler ve aynı sekmedeki firma bilgileri korunur. Yeni ürünler seçilip tekrar gönderilebilir.

Taksit tablosu, ürün seçenekleri, koli bilgileri, filtreler ve görünüm ayarları kullanılmaya devam eder. Eski mağaza metadata dosyalarından fiyat/barkod aktarımı ve fiyat yükleme arayüzüne ait kullanılmayan simgeler/stiller kaldırılmıştır.

## Talep suistimaline karşı koruma

Sınırlar sunucuda, Shopify sorgularından önce uygulanır. Bir ziyaretçi JavaScript’i değiştirse veya farklı sunucu örneklerine istek gönderse de Private Blob’daki tek koşullu kayıt ortak kotayı korur. Sayaçlar kayan zaman aralıkları kullanır; sabit saat sınırında iki kat gönderim yapılmaz.

| Kapsam | Başlangıç sınırı |
| --- | --- |
| Aynı IP / IPv6 ağının /64 bölümü | 10 dakikada 5, 24 saatte 30 yeni deneme |
| Aynı e-posta (büyük/küçük harften bağımsız) | 10 dakikada 3, 24 saatte 20 yeni deneme |
| Tüm katalog | Dakikada 15, saatte 60, 24 saatte 300 yeni deneme |

Sınırlar `lib/request-guard.cjs` içindeki `DEFAULT_LIMITS` değerleriyle ayarlanır. Ürün doğrulamasında başarısız olan yeni denemeler de kotadan düşer. Aynı talep kodunun bağlantı kesintisi sonrası kurtarılması kotayı yeniden tüketmez. Kota bittiğinde 429 ve `Retry-After` döner; formda yaklaşık bekleme süresi gösterilir.

Aynı içerik farklı talep kodlarıyla beş dakika içinde gönderilirse koşullu içerik kaydı ikinci Shopify taslağını engeller; mevcut talep numarası ve tekrar açıklaması gösterilir. Ürün, miktar veya not değiştiğinde ayrı bir talep oluşturulabilir. Başarısız olduğu kesinleşmiş mutasyon yeni gönderimi engellemez.

Görünmeyen bot tuzağı, köken doğrulaması, 20 KB gövde ve 50 ürün sınırları korunur. IP yalnızca Vercel’in `x-vercel-forwarded-for` başlığından alınır; istemcinin normal `X-Forwarded-For` başlığına güvenilmez. Sayaçlarda ham IP/e-posta saklanmaz; sunucu anahtarıyla HMAC özeti ve zaman damgası tutulur. Bu önlemler uygulama katmanındadır; CAPTCHA veya Vercel Firewall yapılandırması eklenmemiştir.

Kaynaklar: [Shopify fiyat listesi](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList), [taslak sipariş oluşturma](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate), [Vercel arka plan işlemleri](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package), [Private Blob](https://vercel.com/docs/vercel-blob/private-storage).
