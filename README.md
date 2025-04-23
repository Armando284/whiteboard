# 🎨 Real-Time Collaborative Whiteboard  

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)  
🌐 **Draw together in real-time, optimized for low-bandwidth connections.**  

---

## ✨ Features  
- **Pixel-perfect sync**: WebSocket binary protocol with RLE compression  
- **Apple Pencil optimized**: Pressure sensitivity & palm rejection  
- **700kbps-friendly**: Works on unstable networks  
- **Zero Front-End frameworks**: Vanilla JS + Express + Node.js for minimal overhead  
- **Cross-platform**: Desktop, iPad, and mobile support  

---

## 🛠️ Tech Stack  
| Component       | Technology           |
|----------------|---------------------|
| Frontend       | HTML5 Canvas + WebSockets |
| Backend        | Node.js + `Express` + `ws` library |
| Compression    | Run-Length Encoding (RLE) |
| Data Protocol  | Binary ArrayBuffer |

---

## 🚀 Quick Start  

```bash
# 1. Clone and install
git clone https://github.com/yourusername/collaborative-whiteboard.git
cd collaborative-whiteboard
npm install

# 2. Run the server (default port: 3000)
node server.js

# 3. Open in browser:
# http://localhost:3000
```

---

## 📊 How It Works  

### Data Flow  
1. **Drawing**:  
   - Mouse/Apple Pencil/touch generates binary coordinates (6 bytes per point)  
   - Debounced 300ms WebSocket sends  

2. **Server**:  
   - Compresses updates using RLE  
   - Broadcasts to all clients  

3. **Clients**:  
   - Decompress RLE → Render to Canvas  

### Apple Pencil Support  
```javascript
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'pen') {
    const pressure = e.pressure * 255; // 0-255 scale
    sendPoint(x, y, pressure);
  }
});
```

---

## 📸 Screenshot  
*(Add screenshot link here)*  

---

## 📜 License  
MIT © [Armando Peña](https://armandodev.vercel.app)  

---

## 🙌 Contributing  
PRs welcome! Key areas for improvement:  
- Better RLE compression  
- Stroke smoothing algorithms  
- Mobile UI enhancements  