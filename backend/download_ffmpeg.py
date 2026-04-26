import urllib.request
import zipfile
import os
import shutil

url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
zip_path = "ffmpeg2.zip"

print("Downloading FFmpeg...")
try:
    urllib.request.urlretrieve(url, zip_path)
    print("Extracting FFmpeg...")
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall("ffmpeg_temp")
    
    exe_path = "ffmpeg_temp/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe"
    shutil.copy(exe_path, "ffmpeg.exe")
    print("FFmpeg setup complete! (ffmpeg.exe)")
except Exception as e:
    print(f"Error: {e}")
finally:
    if os.path.exists(zip_path):
        os.remove(zip_path)
    if os.path.exists("ffmpeg_temp"):
        shutil.rmtree("ffmpeg_temp", ignore_errors=True)
