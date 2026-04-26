import wave
import struct
import math

sample_rate = 16000
duration = 3.0 # 3 seconds
frequency = 440.0

with wave.open('test_audio.wav', 'w') as obj:
    obj.setnchannels(1)
    obj.setsampwidth(2)
    obj.setframerate(sample_rate)
    for i in range(int(sample_rate * duration)):
        value = int(10000.0 * math.sin(2.0 * math.pi * frequency * i / sample_rate))
        data = struct.pack('<h', value)
        obj.writeframesraw(data)
print("test_audio.wav created.")
