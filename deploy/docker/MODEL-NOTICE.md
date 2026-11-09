# Speech aligner model

`/opt/qgrid/models/mms-300m-fa-int8.onnx` is the forced-alignment model qgrid uses to time OpenAI
realtime speech (`withTimestamps`). It is not covered by qgrid's license.

- **Original work**: MMS-FA forced-alignment model from Meta AI's Massively Multilingual Speech project
  (`torchaudio.pipelines.MMS_FA`), via the Hugging Face conversion
  `MahmoudAshraf/mms-300m-1130-forced-aligner` and the fp16 ONNX export `tatsu020/mms-300m-fa-onnx`.
- **Changes**: Cartanova converted the fp16 ONNX export to fp32 and quantized its MatMul weights to
  int8 (onnxruntime dynamic quantization). No retraining or architecture changes.
- **License**: Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0),
  https://creativecommons.org/licenses/by-nc/4.0/ — non-commercial use only.
