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
  - `category` — string, optional; `all`, `doner`, `cafe`, `kofte`.

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

## Görüşme sırasında canlı işletme keşfi (sipariş gerektirmez)

Müşteri "yakınımda köfteci var mı?", "şu an açık bir restoran bul" veya benzeri bir yerel işletme sorusu sorduğunda bu akışı sipariş alma şartı aramadan başlat:

1. Müşterinin söylediği adresi veya tarif ettiği konumu al. Telefon numarasından GPS konumu çıkarmaya çalışma.
2. Adres eksikse yalnızca gerekli mahalle/ilçe/cadde bilgisini sor.
3. `geocode_customer_address` aracını POST ile çağır; `address` alanına müşterinin söylediği adresi gönder.
4. `matched=false` ise koordinat üretme; adresi netleştir. Eşleşme varsa ilçe/mahalle bilgisini müşteriye okuyup konumu teyit et.
5. `find_nearby_food_businesses` aracını POST ile çağır. Köfteci için `category=kofte`, döner için `category=doner`, genel restoran için `category=all` kullan. Varsayılan yarıçap 2500 metredir; müşteri isterse 5000 metreye kadar genişlet.
6. Dönen işletmeleri mesafeye göre değerlendir; isim, kategori, adres ve telefon bilgisi mevcutsa kullan. En fazla 3-5 uygun sonucu kısa ve doğal biçimde sesli sun.
7. `open_status=unknown` ise işletmenin açık olduğunu iddia etme. `opening_hours` alanı varsa "çalışma saati bilgisi var, ancak şu an açık olduğunu canlı doğrulayamıyorum" de. Telefon numarası varsa müşteriye teyit için arayabileceğini söyle; kendin arama başlatma.
8. Sonuç yoksa yarıçapı genişletmeyi veya farklı kategori/mahalle denemeyi teklif et. Uydurma işletme, telefon, fiyat, yol mesafesi ya da açık olma bilgisi verme.

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
