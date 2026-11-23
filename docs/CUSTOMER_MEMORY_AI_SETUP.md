# Aloha Customer Memory AI — Agent Builder bağlantısı

## Yeni API aracı: müşteri hafızasını ara

- Tool name: `lookup_customer_memory`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/customer-memory`
- Header: `Authorization: Bearer {{secrets.ALOHA_WEBHOOK_SECRET}}`
- Body: `{"action":"lookup","phone":"{{sip.phoneNumber}}"}`

Arama başında arayan numara bilinir bilinmez çağır. Yanıt `personalization_allowed=true` ise `greeting` alanındaki metni doğal biçimde kullan ve son 5 görüşme özetini bağlam olarak değerlendir. `needs_consent=true` ise müşteriye kısa bir izin sorusu sor; izin verilmeden kişisel hafıza kaydı oluşturma. Telefon numarası tek başına ödeme, hesap erişimi veya hassas işlem doğrulaması değildir.

## Yeni API aracı: rıza ve hafıza kaydı

- Tool name: `save_customer_memory`
- Method: `POST`
- URL: `https://aloha-kohl.vercel.app/api/customer-memory`
- Header: `Authorization: Bearer {{secrets.ALOHA_WEBHOOK_SECRET}}`
- Body örneği:
```json
{
  "action": "remember",
  "consent": true,
  "phone": "{{sip.phoneNumber}}",
  "full_name": "Müşterinin açıkça verdiği ad soyad",
  "summary": "Görüşmenin kısa, doğrulanmış özeti",
  "intent": "Sipariş / bilgi / destek",
  "preferences": {"contact_preference":"telefon"},
  "order_notes": [],
  "follow_up": "Varsa takip sözü"
}
```

Önce müşteri açıkça hafızaya alınmayı kabul etmelidir. Rıza alındıktan sonra `action=consent` çağrısı da yapılabilir. `remember` çağrısı rıza zamanını da kaydeder; sadece gerçekten söylenen bilgileri gönder. Ham ses/transkript yerine kısa ve gerekli özetleri sakla.

## Yönetim paneli

- Sayfa: `/panel/customer-memory.html`
- Panel anahtarı: mevcut `ALOHA_PANEL_KEY` (tarayıcıda sadece oturum/yerel panel erişimi için kullanılır).
- Ayarlar: hafızayı aç/kapat, isimle karşılama, görüşme özetleri, tercihleri saklama, saklama süresi, karşılama metni.
- Müşteri: ara, geçmişi görüntüle, adı düzelt, hafızayı kapat, rızayı geri alıp kayıtları temizle veya müşteriyi tamamen sil.

## Gerekli Vercel ortam değişkenleri

Mevcut `DATABASE_URL`, `ALOHA_PANEL_KEY` ve `LIVEKIT_WEBHOOK_SECRET` yeterlidir. İstersen ayrı agent anahtarı için `ALOHA_AGENT_API_KEY` tanımlayabilirsin; bu durumda Agent Builder header olarak `x-aloha-agent-key` kullanmalıdır. Gizli anahtarları HTML'e koyma.

## Gizlilik ve güvenlik

Müşteriye hafıza özelliğini açıklayıp açık rızasını al. Rıza geri alındığında hafıza kayıtları silinir. Telefon numarasını sadece müşteri kaydını eşleştirmek için kullan; hassas işlemlerde ayrıca doğrulama iste. Yönetim sayfasını yalnızca güvenilir personelin erişimine aç.
