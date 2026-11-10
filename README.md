# Alaçam Dağıtım Dijital Katalog

## Katalog ve sepet

Her ürün **Liste** görünümünde bir satır, **Kartlar** görünümünde bir kart olarak gösterilir. Varyasyon ve satış seçenekleri satırdan veya karttan seçilebilir. Dikey mobil görünümde kartlar üç sütuna yerleşir. Birden fazla seçim alanı bulunan kartlarda seçenekler ayrı bir panelde açılır.

Sepet müşterinin tarayıcısında saklanır. **WhatsApp’ta aç** düğmesi ürünleri, miktarları ve varsa notu içeren bir teklif talebi taslağını mağazanın WhatsApp sohbetinde açar. Mesajı müşteri gönderir.

## Yerel önizleme

Node.js 22 ile proje klasöründe `npm run dev` çalıştırın ve [127.0.0.1:4173](http://127.0.0.1:4173/) adresini açın.

## Vercel

Git deposunu Vercel’e yeni proje olarak içe aktarın. **Root Directory** olarak deponun kökünü seçin. `vercel.json`, `public` klasöründeki statik arayüzü ve `/api/catalog` ile `/api/installments` fonksiyonlarını yapılandırır. Proje Node.js 22 kullanır. Varsayılan dağıtım için ortam değişkeni, paket kurulumu veya derleme komutu gerekmez.

Katalog sayfası arama motorları için `noindex` olarak işaretlenir. Yayın bağlantısına sahip kişiler kataloğu açabilir.

## Ürün verisi

Arayüz önce kayıtlı kataloğu gösterir, ardından Alaçam Dağıtım mağazasının herkese açık ürün listesini sunucu üzerinden kontrol eder. Vercel güncel yanıtı 15 dakika önbelleğe alır. Kaynağa ulaşılamadığında arayüz son paketlenmiş veriyi ve tarihini gösterir. Kayıtlı veriyi yenilemek için `npm run sync` çalıştırın.

Barkod ve ölçü bilgileri `npm run sync` ile güncellenir. Mağaza istek sınırına ulaşıldığında doğrulanan bilgiler saklanır ve sonraki eşitleme eksik ürünlerden devam eder.

Taksit seçenekleri seçili satış tutarı için PayTR’den alınır. Varsayılan ayarlar mağazanın herkese açık taksit tablosuna aittir. Bu ayarları sunucuda değiştirmek gerekirse `PAYTR_INSTALLMENT_TOKEN` ve `PAYTR_MERCHANT_ID` birlikte tanımlanabilir.
