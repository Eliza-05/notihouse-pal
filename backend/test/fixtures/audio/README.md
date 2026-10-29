# Fixtures de audio y video para pruebas

Grabaciones reales y muy pequeñas (0,6 s), generadas localmente con FFmpeg a partir de fuentes sintéticas: un tono de 440 Hz y un cuadro gris de 16×16. No contienen voz ni datos personales, y no tienen metadatos (`-map_metadata -1`, `+bitexact`).

FFmpeg **no** es una dependencia del backend ni se usa en tiempo de ejecución. Solo se usó para producir estos archivos, que se versionan para que las pruebas validen la estructura de grabaciones reales y no solo de bytes fabricados a mano.

| Archivo               | Contenido                                                                | Resultado esperado |
| --------------------- | ------------------------------------------------------------------------ | ------------------ |
| `voice-opus.webm`     | WebM, una pista de audio Opus                                            | Aceptado           |
| `voice-live.webm`     | WebM en modo «live» (segmento de tamaño desconocido, como MediaRecorder) | Aceptado           |
| `av.webm`             | WebM, Opus + video VP8                                                   | 415 (video)        |
| `video-only.webm`     | WebM, solo video VP8                                                     | 415 (video)        |
| `voice-m4a-brand.m4a` | MP4/AAC, marca principal `M4A `                                          | Aceptado           |
| `voice-isom.m4a`      | MP4/AAC, marca `isom` (sin `M4A `)                                       | Aceptado           |
| `voice-mp42.m4a`      | MP4/AAC, marca `mp42` (sin `M4A `)                                       | Aceptado           |
| `video-only.mp4`      | MP4, solo video MPEG-4                                                   | 415 (video)        |
| `av.mp4`              | MP4, AAC + video MPEG-4                                                  | 415 (video)        |
| `voice-opus.ogg`      | Ogg Opus                                                                 | Aceptado           |
| `voice-vorbis.ogg`    | Ogg Vorbis                                                               | Aceptado           |
| `video-theora.ogg`    | Ogg Theora (video)                                                       | 415                |
| `voice.mp3`           | MP3 (LAME, 32 kbps)                                                      | Aceptado           |
| `voice.wav`           | WAV PCM 16 bits, 16 kHz, mono                                            | Aceptado           |

Regeneración (desde este directorio):

```bash
A="-f lavfi -i sine=frequency=440:duration=0.6:sample_rate=16000"
V="-f lavfi -i color=c=gray:s=16x16:d=0.6:r=5"
O="-map_metadata -1 -fflags +bitexact -flags:a +bitexact -flags:v +bitexact"
ffmpeg -y $A $O -ac 1 -c:a libopus -b:a 16k voice-opus.webm
ffmpeg -y $A $O -ac 1 -c:a libopus -b:a 16k -live 1 -f webm voice-live.webm
ffmpeg -y $A $V $O -ac 1 -c:a libopus -b:a 16k -c:v libvpx -b:v 20k -shortest av.webm
ffmpeg -y $V $O -c:v libvpx -b:v 20k video-only.webm
ffmpeg -y $A $O -ac 1 -c:a aac -b:a 24k voice-m4a-brand.m4a
ffmpeg -y $A $O -ac 1 -c:a aac -b:a 24k -f mp4 -brand isom voice-isom.m4a
ffmpeg -y $A $O -ac 1 -c:a aac -b:a 24k -f mp4 -brand mp42 voice-mp42.m4a
ffmpeg -y $V $O -c:v mpeg4 -b:v 20k -f mp4 video-only.mp4
ffmpeg -y $A $V $O -ac 1 -c:a aac -b:a 24k -c:v mpeg4 -b:v 20k -shortest -f mp4 av.mp4
ffmpeg -y $A $O -ac 1 -c:a libopus -b:a 16k voice-opus.ogg
ffmpeg -y $A $O -ac 1 -c:a libvorbis -q:a 0 voice-vorbis.ogg
ffmpeg -y $V $O -c:v libtheora -q:v 1 video-theora.ogg
ffmpeg -y $A $O -ac 1 -c:a libmp3lame -b:a 32k voice.mp3
ffmpeg -y $A $O -ac 1 -c:a pcm_s16le voice.wav
```
