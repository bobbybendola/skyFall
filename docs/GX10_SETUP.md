# GX10 setup (ASUS Ascent GX10, GB10 Grace Blackwell, 128 GB unified memory)

Source for the pitfalls below: a community DGX Spark setup guide (https://github.com/natolambert/dgx-spark-setup). It is not official ASUS or NVIDIA documentation, so mark anything that surprises you and update this file.

## Known pitfalls (from that guide)
- Needs **CUDA 13** (driver 580.x, Ubuntu 24.04). The GB10 GPU is sm_121.
- Most pip wheels target CUDA 12 and fail with `ImportError: libcudart.so.12`. Install from the **cu130** index.
- Skip `flash-attn`. Use PyTorch SDPA (`attn_implementation="sdpa"`).
- vLLM: default PyPI wheel fails; use the cu130 nightly index or NVIDIA's NGC container. We probably do not need vLLM (CLIP-style classification plus our own PyTorch simulation).
- **Memory is unified.** A "GPU out of memory" can become a system-wide OOM that freezes the machine. Disable swap and cap memory per run.

## Steps
1. Get access: keyboard/monitor or SSH. _Check_: venue network, IP, credentials, rental terms.
2. Check CUDA: `nvidia-smi` and `nvcc --version` (expect CUDA 13).
3. Disable swap:
   ```bash
   sudo swapoff -a
   # then comment out swap lines in /etc/fstab to make it permanent
   ```
4. Install uv and create the environment:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   cd services/gx10-compute
   uv venv && source .venv/bin/activate
   uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
   ```
5. Environment variables (only needed if compiling CUDA code or Triton kernels):
   ```bash
   export TORCH_CUDA_ARCH_LIST="12.1a"
   export TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas
   ```
6. Smoke test (must pass before Phase 2):
   ```bash
   python - <<'EOF'
   import torch, time
   print("cuda:", torch.cuda.is_available(), torch.cuda.get_device_name(0))
   x = torch.randn(100_000, 512, device="cuda")
   t = time.time(); y = (x @ x.T[:, :1024]).sum(); torch.cuda.synchronize()
   print("ok", float(y), f"{(time.time()-t)*1000:.1f} ms")
   EOF
   ```
   A warning that compute capability 12.1 exceeds PyTorch's listed maximum is reported as safe to ignore; verify it still runs.
7. Cap memory when running the service:
   ```bash
   systemd-run --scope -p MemoryMax=100G -p MemorySwapMax=0 \
     uvicorn app:app --host 0.0.0.0 --port 8000
   ```
8. Install Node 18+ for `gx10-bridge`.
9. Vision model: start with a CLIP-style zero-shot classifier. Download weights once while online and keep them local so the offline demo works. Benchmark any larger model before depending on it.

## Run order on demo day
1. SpacetimeDB reachable (local or hosted; decide in the first hour)
2. `gx10-compute` (confirm `/health`)
3. `gx10-bridge` (confirm it registers and reports `compute_status`)
4. `feed-poller` is planned and is not in the repo. Skip it.
5. Big-screen web app and phone page
6. `services/assistant` is optional. Without it, or without `XAI_API_KEY`, the globe button says "assistant offline".

## If setup fails
- Set `USE_GPU=0` and a smaller `SIM_N` to keep building; the architecture is unchanged.
- Never run two heavy jobs without the memory cap.
