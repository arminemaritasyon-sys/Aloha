# Aloha LiveKit Agent Builder — Sipariş araçları

Bu dosya, Aloha Agent Builder içinde tanımlanacak üç HTTP aracının kesin ayarlarını ve konuşma sırasını içerir.

## Kimlik doğrulama

Her araçta şu HTTP header'ını tanımla:

- Header adı: `Authorization`
- Header değeri: `Bearer {{secrets.ALOHA_WEBHOOK_SECRET}}`

Bu, mevcut LiveKit Summary webhook'unda kullanılan aynı LiveKit secret adıdır. Vercel tarafındaki `LIVEKIT_WEBHOOK_SECRET` ile aynı değer olmalıdır. Secret değerini konuşma metnine veya istemci tarafına koyma.

## Tek araç — Konuma göre her tür işletmeyi ara

- Tool name: `search_nearby_places`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/business-search`
- Header: `Authorization: Bearer {{secrets.ALOHA_WEBHOOK_SECRET}}`
- Parameters:
  - `address` — string, required when coordinates are not already known. Müşterinin söylediği adres/mahalle/ilçe.
  - `query` — string, required. Müşterinin isteğini doğal dilde yaz; ör. "köfteci", "şu an açık eczane", "çocuklu aileye uygun kahvaltı yeri", "yakındaki market".
  - `open_now` — boolean, optional. Müşteri açık yer istiyorsa true.
  - `radius_m` — integer, optional, default 5000, max 50000.
  - `latitude`, `longitude` — optional; yalnızca görüşmede doğrulanmış koordinat varsa gönder.

Bu tek araç adresi Google Geocoding ile çözer ve Google Places Text Search ile doğal dil sorgusunu arar. Kategori listesi veya her kategori için ayrı araç gerekmez. Yanıtta işletme adı, adres, telefon, puan, Google'ın verdiği açık olma bilgisi, mesafe ve Google Maps bağlantısı bulunabilir.

## Araç 3 — Müşteri onayı sonrası siparişi kaydet

- Tool name: `save_confirmed_order`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/orders`
- Parameters:
  - `confirmed` — boolean, required. Yalnızca müşterinin son sipariş özetine açıkça "evet/onaylıyorum" demesinden sonra `true`.
  - `customer_name` — string, required.
  - `phone` — string, required.
  - `product` — string, required. Siparişin okunabilir özeti.
  - `quantity` — integer, required.
  - `delivery_address` — string, required. Tam teyit edilmiş adres.
  - `latitude` — number, required. Geocode sonucu.
  - `longitude` — number, required. Geocode sonucu.
  - `business_name` — string, optional.
  - `business_phone` — string, optional.
  - `business_address` — string, optional.
  - `business_osm_id` — string, optional.
  - `order_items` — array, optional. Ürün, adet, seçenek ve notlar.
  - `notes` — string, optional.
  - `price_total` — number, optional; yalnızca doğrulanmış toplam fiyat.
  - `currency` — string, optional; ör. `TRY`.
  - `confirmation_text` — string, optional. Müşterinin onay cümlesi.

API, agent çağrısında `confirmed` true değilse 409 döndürür. Agent siparişleri `confirmed` durumunda kaydedilir. Panelden manuel girilen siparişler eski davranışla `pending` kalır.

## Görüşme sırasında canlı işletme keşfi (sipariş gerektirmez)

Müşteri "yakınımda köfteci var mı?", "şu an açık bir restoran bul" veya benzeri bir yerel işletme sorusu sorduğunda bu akışı sipariş alma şartı aramadan başlat:

1. Müşterinin söylediği adresi veya tarif ettiği konumu al. Telefon numarasından GPS konumu çıkarmaya çalışma.
2. Müşterinin isteğini kendi kelimeleriyle anla; kategori koduna çevirmeye çalışma. Örn. "yakınımda köfteci", "şu an açık eczane", "uygun fiyatlı kahvaltı".
3. Tek araç `search_nearby_places` çağrısına müşterinin adresini `address`, doğal dilde isteğini `query` olarak gönder. Müşteri açık yer istiyorsa `open_now=true` kullan.
4. Adres Google'da eşleşmezse koordinat uydurma; müşteriden mahalle/ilçe/cadde bilgisini netleştir.
5. Sonuçları mesafe, alaka ve mevcut puan bilgisine göre değerlendir. En fazla 3-5 uygun sonucu kısa ve doğal biçimde sesli sun.
6. Google açık olma bilgisi döndürmüşse bunu aktar. Bilgi yoksa açık olduğunu iddia etme.
7. Sonuç yoksa yarıçapı genişletmeyi veya adresi netleştirmeyi teklif et. Uydurma işletme, telefon, fiyat veya yol mesafesi verme.

Örnek konuşma:
- Müşteri: "Kepez'de verdiğim adrese yakın köfteci var mı?"
- Aloha: "Hemen çevrenize bakıyorum. Önce adresinizi haritada doğrulayayım."
- Aloha, adresi doğruladıktan sonra köfteci arama aracını çağırır ve bulunan gerçek sonuçları mesafeleriyle sesli aktarır.

## Aloha'nın konuşma sırası (talimatlara ekle)

1. Sipariş alma isteği netleşince önce tam teslimat adresini topla: il, ilçe, mahalle, cadde/sokak, bina/kapı no, daire/kat ve tarif.
2. `geocode_customer_address` aracını çağır. En iyi eşleşmeyi müşteriye sesli olarak oku; adres/konum onaylanmadan devam etme.
3. `find_nearby_food_businesses` aracını çağır. Uygun işletmeleri mesafeye göre değerlendir. Canlı açık olma ve paket servis durumunu araç doğrulamıyor; bunları kesinmiş gibi söyleme.
4. İşletme seçimi netleşince müşterinin adını ve telefonunu al; ürünleri, adetleri, seçenekleri ve notları eksiksiz topla.
5. İşletme, müşteri adı/telefonu, tüm ürünler, adetler, toplam (yalnızca biliniyorsa) ve tam teslimat adresini tek tek sesli şekilde tekrar oku.
6. Müşteriden açık ve net onay al. "Evet", "onaylıyorum" gibi net onay yoksa `save_confirmed_order` aracını ASLA çağırma. Düzeltme isterse özeti güncelle ve yeniden onay al.
7. Açık onaydan sonra `save_confirmed_order` aracını `confirmed=true` ile çağır. Başarılı yanıt ve sipariş numarası geldikten sonra kaydedildiğini söyle.
8. Bu entegrasyon şu anda işletmeyi telefonla aramaz ve siparişi işletmeye iletmez. Böyle bir işlem yaptığını iddia etme; sipariş panelde onaylandı olarak kayıt edilir.

## Önemli sınırlar

- Geocode ve OSM verileri adres/işletme keşfi içindir; teslimat uygunluğu, işletmenin açık olması, menü, fiyat veya stok garantisi değildir.
- OSM/Photon ortak servisleri hız sınırlarına ve veri eksikliğine tabidir.
- Müşteri açık onay vermeden sipariş kaydı oluşturulmaz.
