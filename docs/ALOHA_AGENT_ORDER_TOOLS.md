# Aloha LiveKit Agent Builder — Sipariş araçları

Bu dosya, Aloha Agent Builder içinde tanımlanacak üç HTTP aracının kesin ayarlarını ve konuşma sırasını içerir.

## Kimlik doğrulama

Her araçta şu HTTP header'ını tanımla:

- Header adı: `Authorization`
- Header değeri: `Bearer {{secrets.ALOHA_WEBHOOK_SECRET}}`

Bu, mevcut LiveKit Summary webhook'unda kullanılan aynı LiveKit secret adıdır. Vercel tarafındaki `LIVEKIT_WEBHOOK_SECRET` ile aynı değer olmalıdır. Secret değerini konuşma metnine veya istemci tarafına koyma.

## Araç 1 — Adresi koordinata çevir

- Tool name: `geocode_customer_address`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/geocode`
- Parameters:
  - `address` — string, required. Müşterinin tam teslimat adresi; il, ilçe, mahalle, cadde/sokak, bina/kapı no, daire, kat ve tarif dahil.

Başarılı yanıt `best_match.latitude`, `best_match.longitude`, `best_match.label` alanlarını döndürür. `matched=false` ise koordinat uydurma; adresi müşteriden netleştir.

## Araç 2 — Yakındaki işletmeleri bul

- Tool name: `find_nearby_food_businesses`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/business-search`
- Parameters:
  - `latitude` — number, required. Geocode sonucundaki en iyi eşleşmenin enlemi.
  - `longitude` — number, required. Geocode sonucundaki en iyi eşleşmenin boylamı.
  - `radius_m` — integer, optional, default 2500, min 300, max 5000.
  - `category` — string, optional; `all`, `doner`, `cafe`.

Sonuçları kuş uçuşu mesafeye göre sıralar. `open_status` şu an için `unknown`; işletmenin açık olduğunu varsayma. `delivery_status` sadece OSM kaydında `delivery=yes` varsa etiketle doğrulanmış olur. Diğer durumlarda paket servisi işletmeden teyit edilmeden müşteriye söz verme. Telefon veya saat bilgisi eksik olabilir. Sonuç yoksa adresi/radyusu düzelt veya müşteriye alternatif sor.

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
