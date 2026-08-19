# ml

Placeholder. PyTorch training code lands with **B3** (ranking model), and the corpus
tooling with **B1**.

Deliberately outside the npm workspaces — this is Python, and nothing in the web app
should ever import from it. The interchange is an ONNX export consumed in-browser by
ONNX Runtime Web, so the boundary is a file, not a call.
