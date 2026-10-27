# -*- coding: utf-8 -*-
"""P0 模型下载脚本：drama-studio 第1/2镜 flf2v 缺失权重。
走 hf-mirror.com 国内镜像。日志写到 E:\drama-studio\tmp\download-p0.log
"""
import os, sys, time, traceback
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'  # 不依赖 hf_transfer，避免没装

from huggingface_hub import hf_hub_download

MODELS_ROOT = r'D:\ComfyUI-V20\ComfyUI\models'
LOG = r'E:\drama-studio\tmp\download-p0.log'
os.makedirs(os.path.dirname(LOG), exist_ok=True)

# (repo_id, repo_path_in_repo, target_subdir_under_models, target_filename)
JOBS = [
    # 1. 文本编码器（wan2.2 流必备，~5GB）
    ('Comfy-Org/Wan_2.1_ComfyUI_repackaged',
     'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
     r'text_encoders\wan2.2', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    # 2. clip_vision（flf2v 首帧编码，~1.2GB）
    ('Comfy-Org/Wan_2.1_ComfyUI_repackaged',
     'split_files/clip_vision/clip_vision_h.safetensors',
     r'clip_vision\wan2.2', 'clip_vision_h.safetensors'),
    # 3. Fun-A14B-InP high-noise-MPS LoRA（~2.5GB）
    ('RunningHubAI/rh-wan2.2-fun-a14b-inp-high-noise-mps-lora',
     'Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors',
     r'loras\wan2.2', 'Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors'),
    # 4. Fun-A14B-InP low-noise-HPS2.1 LoRA（~2.5GB）
    ('RunningHubAI/rh-wan2.2-fun-a14b-inp-low-noise-hps2.1.safetensors-lora',
     'Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors',
     r'loras\wan2.2', 'Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors'),
    # 5. lightx2v I2V 14B rank128 bf16 加速 LoRA（~700MB）
    ('RunningHubAI/rh-lightx2v-i2v-14b-480p-cfg-step-distill-rank128-lora',
     'lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors',
     r'loras\wan2.2', 'lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors'),
    # 6. Wan2.2_Remix i2v high lighting fp8（~14GB）
    ('DanielMarius/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors',
     'Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors',
     r'diffusion_models\Wan2.2_Remix', 'Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors'),
    # 7. Wan2.2_Remix i2v low lighting fp8（~14GB）
    ('DanielMarius/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors',
     'Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors',
     r'diffusion_models\Wan2.2_Remix', 'Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors'),
]

def log(msg):
    line = f'[{time.strftime("%H:%M:%S")}] {msg}'
    print(line, flush=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')

def main():
    log(f'=== P0 download start, {len(JOBS)} jobs ===')
    # 临时下载目录（在 D 盘，避免 C 盘缓存爆）
    cache_dir = r'D:\ComfyUI-V20\hf_cache'
    os.makedirs(cache_dir, exist_ok=True)
    os.environ['HF_HUB_CACHE'] = cache_dir

    done, failed = [], []
    for i, (repo, path_in_repo, subdir, fname) in enumerate(JOBS, 1):
        target_dir = os.path.join(MODELS_ROOT, subdir)
        target = os.path.join(target_dir, fname)
        if os.path.exists(target) and os.path.getsize(target) > 100 * 1024 * 1024:
            log(f'[{i}/{len(JOBS)}] SKIP exists: {target} ({os.path.getsize(target)/1e9:.2f}GB)')
            done.append((fname, 'skipped-exists'))
            continue
        os.makedirs(target_dir, exist_ok=True)
        log(f'[{i}/{len(JOBS)}] START repo={repo} file={path_in_repo}')
        t0 = time.time()
        try:
            # hf_hub_download 下载到 cache，然后复制/移动到 target
            local = hf_hub_download(
                repo_id=repo,
                filename=path_in_repo,
                cache_dir=cache_dir,
                resume_download=True,
            )
            sz = os.path.getsize(local)
            # 移动到目标位置（同盘 D:，os.rename 瞬时）
            import shutil
            shutil.move(local, target)
            dt = time.time() - t0
            log(f'[{i}/{len(JOBS)}] OK {fname} {sz/1e9:.2f}GB in {dt:.0f}s ({sz/1e6/dt:.1f} MB/s) -> {target}')
            done.append((fname, f'{sz/1e9:.2f}GB {dt:.0f}s'))
        except Exception as e:
            dt = time.time() - t0
            log(f'[{i}/{len(JOBS)}] FAIL {fname} after {dt:.0f}s: {e}')
            log(traceback.format_exc())
            failed.append((fname, str(e)))

    log('=== SUMMARY ===')
    for n, s in done: log(f'  OK   {n}  {s}')
    for n, e in failed: log(f'  FAIL {n}  {e}')
    log(f'=== done {len(done)}/{len(JOBS)}, failed {len(failed)} ===')

if __name__ == '__main__':
    main()
