# 🎧 Ondas LAN — Hub & Mixer de Áudio via Wi-Fi / P2P

Reúna o áudio do seu **PC Windows**, notebooks e outros aparelhos direto no **fone Bluetooth conectado ao seu iPhone ou Android**, sem precisar desconectar e reconectar o fone a cada troca de dispositivo.

## 🚀 Acesso Direto pela Web (Sem instalar nada!)

👉 **[Abrir Ondas LAN (Web App P2P)](https://alfastage.github.io/ondas-lan/)**

1. **No PC Windows (Chrome ou Edge):** Abra o link acima, clique em **`📡 Iniciar Transmissão Deste Aparelho`**, selecione **Tela inteira** (ou uma aba) e marque **`Compartilhar também o áudio do sistema`**.
2. **No iPhone / Android (com seu fone Bluetooth conectado):** Aponte a câmera para o **QR Code** na tela do PC e toque no botão verde **`▶ Ativar Escuta & 2º Plano`**.
3. Ajuste o volume individual de cada aparelho, posição estéreo (L/R), graves/agudos ou ative **Prioridade (Auto-Ducking)**!

---

## 💻 Modo Servidor Local Offline (Opcional — via Node.js no Windows)

Caso queira rodar 100% offline na sua rede Wi-Fi local (sem depender de internet para sinalização P2P):

1. Baixe o pacote **`.ZIP`** direto pelo botão amarelo no topo do site (ou clone este repositório).
2. Dê dois cliques em **`iniciar-windows.bat`** (requer [Node.js](https://nodejs.org/)).
3. Abra `http://localhost:3000` no PC e leia o QR Code da rede local (`192.168.x.x:3000`) no seu iPhone.
