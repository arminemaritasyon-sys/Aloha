# Aloha Customer Memory AI — LiveKit Agent Builder kurulumu

Bu entegrasyon iki HTTP aracıyla çalışır. API ve Neon tabloları uygulamada hazırdır; araçlar LiveKit Agent Builder'da aynı agent'e eklenmelidir.

## 1. LiveKit secret

LiveKit Agent Builder → Secrets bölümünde şu secret'ı oluştur:

- Secret adı: `LIVEKIT_WEBHOOK_SECRET`
- Değeri: Vercel Production ortamındaki `LIVEKIT_WEBHOOK_SECRET` değerinin **aynısı**

Önemli: Önceki talimatta `ALOHA_WEBHOOK_SECRET` adı yazıyordu. Sunucu bu isimle bir environment variable okumuyor; Bearer değerini `LIVEKIT_WEBHOOK_SECRET` ile veya `x-aloha-agent-key` header'ını `ALOHA_AGENT_API_KEY` ile doğruluyor. Bu nedenle aşağıdaki ayarı aynen kullan.

## 2. Araç: müşteriyi ara

- Tool name: `lookup_customer_memory`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/workspace?resource=customer-memory`
- Header:
  - Name: `Authorization`
  - Value: `Bearer {{secrets.LIVEKIT_WEBHOOK_SECRET}}`
- Body (JSON):
```json
{
  "action": "lookup",
  "phone": "{{sip.phoneNumber}}"
}
```

Agent bu aracı her gelen çağrının başında, arayan numara belli olur olmaz çağırmalıdır. Telefon numarası bulunmuyorsa boş/uydurma numarayla çağırmamalı; müşteriden numarayı istemek yerine görüşmeye normal devam etmelidir.

Yanıt davranışı:
- `personalization_allowed=true` ve `greeting` doluysa müşteriyi bu metinle karşıla.
- `memories` içindeki son görüşme notlarını yalnızca konuşmayı sürdürmek için kullan.
- `needs_consent=true` ise müşteriye hafıza özelliğini kısaca açıkla ve izin iste. İzin verilmeden isim veya görüşme özeti kaydetme.
- Kayıt bulunamazsa müşteriyi tanıyormuş gibi davranma.

## 3. Araç: müşteriyi kaydet

- Tool name: `save_customer_memory`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/workspace?resource=customer-memory`
- Header:
  - Name: `Authorization`
  - Value: `Bearer {{secrets.LIVEKIT_WEBHOOK_SECRET}}`
- Body (JSON):
```json
{
  "action": "remember",
  "consent": true,
  "phone": "{{sip.phoneNumber}}",
  "full_name": "{{customer_name}}",
  "summary": "{{short_verified_call_summary}}",
  "intent": "{{call_intent}}",
  "preferences": {},
  "order_notes": [],
  "follow_up": ""
}
```

Agent bu aracı yalnızca müşteri açıkça hafızaya kaydedilmeyi kabul ettikten sonra çağırmalıdır. `full_name` alanına müşterinin söylediği adı yaz; söylemediği soyadı veya başka bilgiyi uydurma. Görüşme devam ederken adını öğrendiysen ve müşteri hafızaya kaydetmeye izin verdiyse, aracı görüşme sonunda beklemeden çağırabilir. Görüşme özeti henüz yoksa `summary` alanına yalnızca doğrulanmış kısa bir not gönder; boş/uydurma özet gönderme.

## 4. Agent talimatlarına eklenecek metin

Aşağıdaki talimatları agent'in ana system instructions bölümüne ekle:

```text
MÜŞTERİYİ TANIMA VE HAFIZA

1. Her gelen çağrının başında, arayan telefon numarası LiveKit SIP bilgisinde mevcutsa lookup_customer_memory aracını çağır.
2. Kayıtlı müşteri ve kişiselleştirilmiş karşılama geldiyse müşteriyi adıyla doğal biçimde karşıla. Örneğin: “Merhaba Hakan Bey, tekrar hoş geldiniz. Size nasıl yardımcı olabilirim?”
3. Müşteri kayıtlı değilse veya hafıza izni yoksa kendisini tanıyormuş gibi davranma.
4. Müşteri adını söylediğinde, sonraki aramalarda hatırlanmak isteyip istemediğini açıkça sor. Örneğin: “Size sonraki aramalarınızda adınızla hitap edebilmem için bu bilgiyi kaydetmeme izin verir misiniz?”
5. Açıkça evet demeden save_customer_memory aracını çağırma. Hayır derse hiçbir müşteri hafızası kaydı oluşturma.
6. İzin verirse söylediği adı, gerçek arayan telefon numarasıyla birlikte kaydet. Sadece müşterinin doğruladığı bilgileri kullan.
7. Sonraki aramalarda aynı telefon numarası eşleşirse kayıtlı adı kullan. Numara eşleşmiyorsa başka bir müşterinin hafızasını kullanma.
8. Telefon numarası tek başına ödeme, hesap erişimi veya hassas işlem doğrulaması değildir.
9. Müşteri hafızasını sorması veya silinmesini istemesi halinde bu isteği açıkça ele al; izinsiz kişisel veri saklama.
```

## 5. Hızlı bağlantı testi

Agent Builder'da iki aracı kaydedip agent'i yayımladıktan sonra:

1. İlk aramada agent'e “Benim adım Hakan” de.
2. Agent hafızaya kaydetmek için izin istesin; açıkça “Evet, kaydedebilirsin” de.
3. Agent'in `save_customer_memory` aracını başarıyla çağırdığını kontrol et.
4. Aynı telefon numarasından ikinci kez ara.
5. Agent'in `lookup_customer_memory` aracını çağırıp seni “Hakan Bey” diye karşılamasını doğrula.

## 6. Yönetim paneli ve gizlilik

- Sayfa: `/panel/customer-memory.html`
- Panel erişimi: mevcut `ALOHA_PANEL_KEY`
- Vercel ortam değişkenleri: `DATABASE_URL`, `ALOHA_PANEL_KEY`, `LIVEKIT_WEBHOOK_SECRET`
- Alternatif agent anahtarı kullanılacaksa Vercel'de `ALOHA_AGENT_API_KEY` tanımla ve araçlarda `x-aloha-agent-key: {{secrets.ALOHA_AGENT_API_KEY}}` header'ını kullan.

Müşteriye hafıza özelliğini açıkla ve açık rızasını al. Rıza geri çekilirse yönetim panelinden hafızayı kapatıp kayıtları temizle. Ham ses/transkript yerine gerekli kısa notları sakla.