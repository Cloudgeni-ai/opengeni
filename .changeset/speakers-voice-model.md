---
"@opengeni/worker-bundle": patch
---

Speaker detection tells voices apart better on phone and laptop meetings. The worker image now ships 3D-Speaker CAM++ "common advanced", trained on about 200,000 speakers, instead of the VoxCeleb-only CAM++. On real meetings it confuses two voices about half as often (12 instead of 22 percent equal error rate) and attributes fewer words to the wrong person; on AMI it scores the same. WeSpeaker models also get the mean-normalized features they were trained on. Voiceprints learned with the earlier model are kept apart from the new model's, so people need confirming again before they are suggested.
