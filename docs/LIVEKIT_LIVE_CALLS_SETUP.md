# Aloha Live — gerçek telefon görüşmesi akışı

## Vercel ortam değişkenleri

Production ortamında şu değişkenler bulunmalıdır:

- `DATABASE_URL`
- `ALOHA_PANEL_KEY`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

`LIVEKIT_API_KEY` ve `LIVEKIT_API_SECRET`, LiveKit Cloud projesindeki webhook imza anahtarıyla aynı anahtar çiftini kullanmalıdır. Değerleri tarayıcıya veya istemci koduna koymayın.

## LiveKit Cloud webhook

LiveKit Cloud → Project → Settings → Webhooks → Create new webhook:

- Name: `Aloha Live Call Events`
- URL: `https://aloha-kohl.vercel.app/api/live-call-events`
- Signing API key: Vercel'deki `LIVEKIT_API_KEY` ile eşleşen API key
- Events:
  - `room_started`
  - `participant_joined`
  - `participant_left`
  - `participant_connection_aborted`
  - `room_finished`

Webhook imzası API key/secret ile doğrulanır; gövdenin ham SHA-256 özeti de kontrol edilir.

## Durum eşlemesi

- `room_started` → `ringing` (gelen SIP odası açıldı; cevap bekleniyor)
- `participant_joined` → `in_progress` (medya bağlantısı kuruldu)
- `participant_left` veya `room_finished` → `completed`
- `participant_connection_aborted` → `missed`

Arayan numarası LiveKit SIP katılımcısının `sip.phoneNumber` özelliğinden okunur. LiveKit bu bilgiyi ilk oda olayında henüz vermiyorsa kart önce oda adıyla görünür; numara katılımcı bilgisi ulaştığında eklenir.

## Panel davranışı

- `/api/live-calls` panel anahtarıyla korunur.
- Live sayfası aktif arama durumlarını 2 saniyede bir yeniler.
- Görüşme/sipariş/takip arşivleri 10 saniyede bir yenilenir.
- Aktif arama kartları `ÇALIYOR` ve `GÖRÜŞMEDE` durumlarını ayırır.

## Önemli

LiveKit'in `participant_joined` olayı, medya bağlantısı kurulduktan sonra gelir; ilk çalma anını yakalamak için `room_started` olayı kullanılır. SIP kurulumunuzda arayan taraf henüz oda oluşturulmadan önce başka bir sağlayıcıda bekletiliyorsa, o sağlayıcının ayrı ringing webhook'u da bağlanmalıdır.
