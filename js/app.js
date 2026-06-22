// OPULENCE PWA Core Application Logic

// 1. Firebase Initialization & Failover
let db = null;
let auth = null;
let useMockData = false;

try {
  if (window.firebase && window.OPULENCE_CONFIG && window.OPULENCE_CONFIG.firebase) {
    firebase.initializeApp(window.OPULENCE_CONFIG.firebase);
    db = firebase.firestore();
    auth = firebase.auth();
    console.log("Firebase services initialized successfully.");
  } else {
    throw new Error("Firebase SDK not loaded or config missing.");
  }
} catch (e) {
  console.warn("Firebase not available, entering LocalStorage mock mode.", e);
  useMockData = true;
  setupMockDatabase();
}

function setupMockDatabase() {
  if (!localStorage.getItem('mock_products')) {
    localStorage.setItem('mock_products', JSON.stringify(window.OPULENCE_CONFIG.mockProducts));
  }
  if (!localStorage.getItem('mock_orders')) {
    localStorage.setItem('mock_orders', JSON.stringify([]));
  }
}

// Data Resolvers
async function getProducts() {
  if (useMockData) {
    return JSON.parse(localStorage.getItem('mock_products'));
  }
  try {
    const snapshot = await db.collection('products').get();
    if (snapshot.empty) {
      console.log("Seeding Firestore with default products...");
      for (const prod of window.OPULENCE_CONFIG.mockProducts) {
        await db.collection('products').doc(prod.id).set(prod);
      }
      const newSnapshot = await db.collection('products').get();
      return newSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error("Firestore getProducts failed, using mock data:", error);
    useMockData = true;
    setupMockDatabase();
    return JSON.parse(localStorage.getItem('mock_products'));
  }
}

async function getProductById(id) {
  if (useMockData) {
    const products = JSON.parse(localStorage.getItem('mock_products'));
    return products.find(p => p.id === id);
  }
  try {
    const doc = await db.collection('products').doc(id).get();
    if (doc.exists) {
      return { id: doc.id, ...doc.data() };
    }
    return null;
  } catch (error) {
    console.error("Firestore getProductById failed, using mock:", error);
    const products = JSON.parse(localStorage.getItem('mock_products'));
    return products.find(p => p.id === id);
  }
}

async function updateProductStock(id, newStock) {
  if (useMockData) {
    const products = JSON.parse(localStorage.getItem('mock_products'));
    const index = products.findIndex(p => p.id === id);
    if (index !== -1) {
      products[index].stock = parseInt(newStock);
      localStorage.setItem('mock_products', JSON.stringify(products));
      return true;
    }
    return false;
  }
  try {
    await db.collection('products').doc(id).update({ stock: parseInt(newStock) });
    return true;
  } catch (error) {
    console.error("Firestore stock update failed:", error);
    return false;
  }
}

async function createOrder(orderData) {
  if (useMockData) {
    const orders = JSON.parse(localStorage.getItem('mock_orders'));
    orders.push(orderData);
    localStorage.setItem('mock_orders', JSON.stringify(orders));
    
    // Decrement stock in mock
    const products = JSON.parse(localStorage.getItem('mock_products'));
    orderData.items.forEach(item => {
      const p = products.find(prod => prod.id === item.id);
      if (p) p.stock = Math.max(0, p.stock - item.qty);
    });
    localStorage.setItem('mock_products', JSON.stringify(products));
    return true;
  }
  try {
    await db.collection('orders').add(orderData);
    
    // Decrement product stock
    for (const item of orderData.items) {
      const docRef = db.collection('products').doc(item.id);
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (doc.exists) {
          const currentStock = doc.data().stock || 0;
          transaction.update(docRef, { stock: Math.max(0, currentStock - item.qty) });
        }
      });
    }
    return true;
  } catch (error) {
    console.error("Firestore order creation failed:", error);
    return false;
  }
}

function listenToOrders(callback) {
  if (useMockData) {
    const handleStorageChange = () => {
      const orders = JSON.parse(localStorage.getItem('mock_orders')) || [];
      callback(orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    };
    window.addEventListener('storage', handleStorageChange);
    handleStorageChange();
    return () => window.removeEventListener('storage', handleStorageChange);
  }
  try {
    return db.collection('orders').orderBy('createdAt', 'desc').onSnapshot((snapshot) => {
      const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(orders);
    }, (error) => {
      console.error("Firestore orders listen failed, fallback to mock:", error);
      useMockData = true;
      setupMockDatabase();
      listenToOrders(callback);
    });
  } catch (error) {
    console.error("Orders collection listen setup failed:", error);
    useMockData = true;
    setupMockDatabase();
    return listenToOrders(callback);
  }
}

async function updateOrderStatus(orderId, newStatus) {
  if (useMockData) {
    const orders = JSON.parse(localStorage.getItem('mock_orders'));
    const index = orders.findIndex(o => o.id === orderId || o.createdAt === orderId);
    if (index !== -1) {
      orders[index].status = newStatus;
      localStorage.setItem('mock_orders', JSON.stringify(orders));
      window.dispatchEvent(new Event('storage'));
      return true;
    }
    return false;
  }
  try {
    await db.collection('orders').doc(orderId).update({ status: newStatus });
    return true;
  } catch (error) {
    console.error("Firestore order status update failed:", error);
    return false;
  }
}

// 2. Shopping Cart Engine
let cart = JSON.parse(localStorage.getItem('opulence_cart')) || [];

function saveCart() {
  localStorage.setItem('opulence_cart', JSON.stringify(cart));
  updateCartUI();
}

function addToCart(product, qty = 1) {
  const existingItem = cart.find(item => item.id === product.id);
  if (existingItem) {
    if (existingItem.qty + qty <= product.stock) {
      existingItem.qty += qty;
      showToast(`${product.name} actualizado en el carrito.`);
    } else {
      showToast(`Stock insuficiente. Solo quedan ${product.stock} unidades.`, true);
    }
  } else {
    if (product.stock >= qty) {
      cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        qty: qty,
        stock: product.stock
      });
      showToast(`${product.name} agregado al carrito.`);
    } else {
      showToast("Producto agotado.", true);
    }
  }
  saveCart();
  openCartDrawer();
}

function updateCartQuantity(id, qty) {
  const item = cart.find(i => i.id === id);
  if (item) {
    if (qty <= 0) {
      removeFromCart(id);
      return;
    }
    if (qty <= item.stock) {
      item.qty = qty;
    } else {
      showToast(`Stock máximo disponible (${item.stock}) alcanzado.`, true);
    }
    saveCart();
  }
}

function removeFromCart(id) {
  cart = cart.filter(item => item.id !== id);
  saveCart();
}

function clearCart() {
  cart = [];
  saveCart();
}

function getCartTotal() {
  return cart.reduce((total, item) => total + (item.price * item.qty), 0);
}

function updateCartUI() {
  const cartCountElements = document.querySelectorAll('.cart-count');
  const count = cart.reduce((total, item) => total + item.qty, 0);
  cartCountElements.forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'flex' : 'none';
  });

  const cartContainer = document.getElementById('cart-items-list');
  if (!cartContainer) return;

  if (cart.length === 0) {
    cartContainer.innerHTML = `<div class="cart-empty-message">SU CARRITO ESTÁ VACÍO.</div>`;
    document.getElementById('cart-total-val').textContent = "$0";
    return;
  }

  let html = '';
  cart.forEach(item => {
    html += `
      <div class="cart-item">
        <img src="${item.image}" alt="${item.name}" class="cart-item-img">
        <div class="cart-item-details">
          <h4 class="cart-item-name">${item.name}</h4>
          <p class="cart-item-price">$${item.price.toLocaleString()}</p>
          <div class="cart-item-controls">
            <div class="cart-item-qty">
              <button onclick="updateCartQuantity('${item.id}', ${item.qty - 1})">-</button>
              <span>${item.qty}</span>
              <button onclick="updateCartQuantity('${item.id}', ${item.qty + 1})">+</button>
            </div>
            <button onclick="removeFromCart('${item.id}')" class="cart-item-remove">Eliminar</button>
          </div>
        </div>
      </div>
    `;
  });
  cartContainer.innerHTML = html;
  document.getElementById('cart-total-val').textContent = `$${getCartTotal().toLocaleString()}`;
}

function openCartDrawer() {
  document.getElementById('cart-drawer').classList.add('open');
  document.getElementById('cart-overlay').classList.add('open');
}

function closeCartDrawer() {
  document.getElementById('cart-drawer').classList.remove('open');
  document.getElementById('cart-overlay').classList.remove('open');
}

// 3. Notification Toast
function showToast(message, isError = false) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.position = 'fixed';
  toast.style.bottom = '2rem';
  toast.style.left = '2rem';
  toast.style.backgroundColor = isError ? 'var(--shop-accent)' : '#111111';
  toast.style.color = '#FFFFFF';
  toast.style.padding = '1rem 2rem';
  toast.style.fontFamily = 'var(--shop-font-title)';
  toast.style.textTransform = 'uppercase';
  toast.style.fontSize = '0.8rem';
  toast.style.letterSpacing = '0.1em';
  toast.style.zIndex = '9999';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(20px)';
  toast.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
  toast.style.border = '1px solid rgba(255,255,255,0.1)';
  toast.textContent = message;

  document.body.appendChild(toast);
  toast.offsetHeight; // trigger reflow
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// 4. Checkout Modal & Redirection
function openCheckoutModal() {
  if (cart.length === 0) {
    showToast("Su carrito está vacío.", true);
    return;
  }
  closeCartDrawer();

  const modal = document.createElement('div');
  modal.id = 'checkout-modal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100%';
  modal.style.height = '100%';
  modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
  modal.style.zIndex = '3500';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.padding = '1rem';
  modal.innerHTML = `
    <div style="background-color:#FFFFFF; width:100%; max-width:500px; padding:3rem; border:var(--shop-border-dark); position:relative; color:#111111; font-family:var(--shop-font-body);">
      <button onclick="document.getElementById('checkout-modal').remove()" style="position:absolute; top:1.5rem; right:1.5rem; font-size:1.5rem; background:none; border:none; cursor:pointer;">✕</button>
      <h3 style="font-family:var(--shop-font-title); text-transform:uppercase; letter-spacing:0.1em; font-size:1.4rem; margin-bottom:0.5rem; text-align:center;">DETALLES DE ENVÍO</h3>
      <p style="font-size:0.8rem; color:var(--shop-text-sec); text-transform:uppercase; letter-spacing:0.05em; text-align:center; margin-bottom:2rem;">Complete la información para procesar el pago</p>
      <form id="checkout-form">
        <div class="login-form-group">
          <label>Nombre Completo</label>
          <input type="text" id="cust-name" required placeholder="Escriba su nombre">
        </div>
        <div class="login-form-group">
          <label>Email de Contacto</label>
          <input type="email" id="cust-email" required placeholder="correo@ejemplo.com">
        </div>
        <div class="login-form-group">
          <label>Teléfono</label>
          <input type="tel" id="cust-phone" required placeholder="+123456789">
        </div>
        <div class="login-form-group">
          <label>Dirección de Envío</label>
          <input type="text" id="cust-address" required placeholder="Calle, Ciudad, Código Postal">
        </div>
        <button type="submit" class="shop-btn-primary" style="width:100%; margin-top:1.5rem;">PROCEDER AL PAGO ($${getCartTotal().toLocaleString()})</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('cust-name').value;
    const email = document.getElementById('cust-email').value;
    const phone = document.getElementById('cust-phone').value;
    const address = document.getElementById('cust-address').value;

    const orderData = {
      id: "ord_" + Date.now(),
      createdAt: new Date().toISOString(),
      customer: { name, email, phone, address },
      items: cart.map(item => ({ id: item.id, name: item.name, price: item.price, qty: item.qty })),
      total: getCartTotal(),
      status: "Pendiente"
    };

    showToast("Guardando orden y verificando inventario...");

    const success = await createOrder(orderData);
    if (success) {
      showToast("Orden guardada. Redirigiendo a Mercado Pago...");
      clearCart();
      document.getElementById('checkout-modal').remove();
      
      const encodedTitle = encodeURIComponent(`OPULENCE Collection Order - Total $${orderData.total}`);
      const mpUrl = `https://www.mercadopago.com/checkout/start?pref_id=mock_pref_${Date.now()}&title=${encodedTitle}`;
      
      setTimeout(() => {
        window.location.href = mpUrl;
      }, 1500);
    } else {
      showToast("Error al procesar la orden. Verifique el stock disponible.", true);
    }
  });
}

// 5. Dynamic HTML Templates
const templates = {
  shop: async (container) => {
    container.innerHTML = `
      <div class="shop-container">
        <div class="shop-header">
          <span class="shop-label">Colección de Ingeniería</span>
          <h2 class="shop-title">Catálogo Completo</h2>
        </div>
        <div style="text-align: center; color: var(--shop-text-sec); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 3.5rem;">
          Pase el cursor sobre la pieza para ver su presentación técnica en video.
        </div>
        <div class="shop-grid" id="products-grid-container">
          <div style="text-align: center; grid-column: 1/-1; padding: 4rem; color:var(--shop-text-sec);">Cargando catálogo premium...</div>
        </div>
      </div>
    `;

    const products = await getProducts();
    const grid = document.getElementById('products-grid-container');
    if (!grid) return;

    if (!products || products.length === 0) {
      grid.innerHTML = `<div style="text-align: center; grid-column: 1/-1; padding: 4rem;">Colección vacía.</div>`;
      return;
    }

    let html = '';
    products.forEach(p => {
      const isOutOfStock = p.stock <= 0;
      html += `
        <div class="product-card">
          <div class="product-card-media" onclick="location.hash = '#/product/${p.id}'" style="cursor: pointer;">
            <img src="${p.image}" alt="${p.name}" class="product-card-img" loading="lazy">
            <video class="product-card-video" src="${p.video}" loop muted playsinline autoplay></video>
          </div>
          <div class="product-card-info">
            <span class="product-card-category">${p.category}</span>
            <h3 class="product-card-name">${p.name}</h3>
            <p class="product-card-price">$${p.price.toLocaleString()} USD</p>
            <div class="product-card-actions">
              <button onclick="location.hash = '#/product/${p.id}'" class="shop-btn-secondary product-card-btn">DETALLES</button>
              ${isOutOfStock 
                ? `<button class="shop-btn-primary product-card-btn" style="background-color: var(--shop-text-sec);" disabled>AGOTADO</button>`
                : `<button onclick="window.appActions.addProductToCart('${p.id}')" class="shop-btn-primary product-card-btn">ADQUIRIR</button>`
              }
            </div>
          </div>
        </div>
      `;
    });
    grid.innerHTML = html;
  },
  product: async (container, id) => {
    container.innerHTML = `<div style="text-align:center; padding:10rem; color:var(--shop-text-sec);">Buscando especificaciones de la pieza...</div>`;
    
    const p = await getProductById(id);
    if (!p) {
      container.innerHTML = `
        <div style="text-align:center; padding:10rem;">
          <h2 style="font-family:var(--shop-font-title); text-transform:uppercase; margin-bottom:2rem;">Producto no encontrado</h2>
          <a href="#/shop" class="shop-btn-primary">Volver al Catálogo</a>
        </div>
      `;
      return;
    }

    const isOutOfStock = p.stock <= 0;
    
    container.innerHTML = `
      <div class="product-detail-container">
        <div class="product-detail-back">
          <a href="#/shop" class="product-detail-back-link">← Volver al Catálogo</a>
        </div>
        <div class="product-detail-grid">
          <div class="product-detail-media">
            <div class="product-detail-video-wrapper">
              <video src="${p.video}" autoplay muted loop playsinline></video>
            </div>
            <img src="${p.image}" alt="${p.name}" class="product-detail-main-img">
          </div>
          <div class="product-detail-info">
            <span class="product-detail-cat">${p.category}</span>
            <h1 class="product-detail-name">${p.name}</h1>
            <p class="product-detail-price">$${p.price.toLocaleString()} USD</p>
            <p class="product-detail-desc">${p.description}</p>
            
            <div class="product-detail-specs">
              <h3 class="product-detail-specs-title">Ficha Técnica</h3>
              <ul class="product-detail-specs-list">
                ${p.specs.map(spec => `<li>${spec}</li>`).join('')}
              </ul>
            </div>

            <div class="product-detail-actions">
              <div class="stock-status">
                Estado: ${isOutOfStock 
                  ? `<span class="stock-out">Agotado temporalmente</span>` 
                  : `<span class="stock-in">En Stock (${p.stock} unidades disponibles)</span>`
                }
              </div>
              ${isOutOfStock 
                ? `<button class="shop-btn-primary" style="background-color: var(--shop-text-sec); width: 100%;" disabled>PIEZA AGOTADA</button>`
                : `<button onclick="window.appActions.addProductToCart('${p.id}')" class="shop-btn-primary" style="width: 100%;">ADQUIRIR PIEZA</button>`
              }
            </div>
          </div>
        </div>
      </div>
    `;
  },
  admin: async (container) => {
    let currentUser = null;
    if (auth) {
      currentUser = auth.currentUser;
    } else {
      currentUser = JSON.parse(localStorage.getItem('mock_user'));
    }

    const isAdmin = currentUser && currentUser.email === window.OPULENCE_CONFIG.adminEmail;

    if (!isAdmin) {
      if (currentUser && auth) auth.signOut();
      renderAdminLogin(container);
      return;
    }

    renderAdminDashboard(container, currentUser);
  }
};

function renderAdminLogin(container) {
  container.innerHTML = `
    <div class="login-card">
      <h2 class="login-title">ADMINISTRACIÓN</h2>
      <p class="login-subtitle">Solo personal autorizado</p>
      <form id="admin-login-form">
        <div class="login-form-group">
          <label>Email Corporativo</label>
          <input type="email" id="login-email" required placeholder="nombre@opulence.com">
        </div>
        <div class="login-form-group">
          <label>Contraseña</label>
          <input type="password" id="login-password" required placeholder="••••••••">
        </div>
        <button type="submit" class="shop-btn-primary login-btn">Iniciar Sesión</button>
      </form>
      <div id="login-error-msg" class="login-error" style="display:none;"></div>
      <p style="font-size:0.7rem; color:var(--shop-text-sec); text-align:center; margin-top:2.5rem; line-height:1.4; text-transform:uppercase; letter-spacing:0.05em;">
        Nota: Registre el correo del administrador (${window.OPULENCE_CONFIG.adminEmail}) en Firebase. En modo Demo, use cualquier contraseña.
      </p>
    </div>
  `;

  document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error-msg');
    
    errorEl.style.display = 'none';
    showToast("Autenticando...");

    if (email !== window.OPULENCE_CONFIG.adminEmail) {
      errorEl.textContent = "Acceso Denegado: Email no autorizado.";
      errorEl.style.display = 'block';
      showToast("Email no autorizado.", true);
      return;
    }

    if (useMockData) {
      localStorage.setItem('mock_user', JSON.stringify({ email }));
      showToast("Acceso de Demo concedido.");
      handleRouting();
    } else {
      try {
        await auth.signInWithEmailAndPassword(email, password);
        showToast("Sesión iniciada.");
        handleRouting();
      } catch (err) {
        console.error("Firebase Login failed:", err);
        errorEl.textContent = "Error: Credenciales inválidas o error de red.";
        errorEl.style.display = 'block';
        showToast("Error de autenticación.", true);
      }
    }
  });
}

let ordersUnsubscribe = null;
async function renderAdminDashboard(container, user) {
  if (ordersUnsubscribe) {
    ordersUnsubscribe();
    ordersUnsubscribe = null;
  }

  container.innerHTML = `
    <div class="admin-container">
      <div class="admin-header-row">
        <div>
          <h1 class="admin-title">PANEL DE OPERACIONES</h1>
          <div style="font-size: 0.8rem; color: var(--shop-text-sec); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 0.5rem;">
            E-commerce Monitoreado en Tiempo Real
          </div>
        </div>
        <div class="admin-profile">
          <span class="admin-email-badge">${user.email}</span>
          <button onclick="window.appActions.adminLogout()" class="logout-btn">Cerrar Sesión</button>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">Ingresos Totales (USD)</span>
          <span class="stat-value primary" id="stat-revenue">$0</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Órdenes Recibidas</span>
          <span class="stat-value" id="stat-orders-count">0</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Piezas en Catálogo</span>
          <span class="stat-value" id="stat-products-count">0</span>
        </div>
      </div>

      <div class="admin-section">
        <h2 class="admin-section-title">Monitoreo de Órdenes</h2>
        <div class="table-wrapper">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Fecha/ID</th>
                <th>Cliente</th>
                <th>Piezas</th>
                <th>Total</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody id="admin-orders-rows">
              <tr>
                <td colspan="5" style="text-align:center; padding:3rem; color:var(--shop-text-sec);">Buscando transacciones en vivo...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="admin-section" style="margin-top: 5rem;">
        <h2 class="admin-section-title">Gestión de Inventario</h2>
        <div class="table-wrapper">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Categoría</th>
                <th>Precio</th>
                <th>Stock</th>
                <th>Modificar</th>
              </tr>
            </thead>
            <tbody id="admin-inventory-rows">
              <tr>
                <td colspan="5" style="text-align:center; padding:3rem; color:var(--shop-text-sec);">Cargando inventario...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  ordersUnsubscribe = listenToOrders((orders) => {
    const ordersBody = document.getElementById('admin-orders-rows');
    const revenueEl = document.getElementById('stat-revenue');
    const countEl = document.getElementById('stat-orders-count');
    
    if (!ordersBody) return;

    if (!orders || orders.length === 0) {
      ordersBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:3rem; color:var(--shop-text-sec);">Ninguna orden registrada en la plataforma.</td></tr>`;
      revenueEl.textContent = "$0";
      countEl.textContent = "0";
      return;
    }

    countEl.textContent = orders.length;
    const revenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    revenueEl.textContent = `$${revenue.toLocaleString()}`;

    let html = '';
    orders.forEach(o => {
      const date = new Date(o.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
      const itemsText = o.items.map(i => `${i.name} (${i.qty})`).join('<br>');
      const id = o.id || o.createdAt;
      
      html += `
        <tr>
          <td>
            <div style="font-weight:600; font-family:var(--shop-font-title);">${id.substring(0, 12)}</div>
            <div style="font-size:0.75rem; color:var(--shop-text-sec); margin-top:0.2rem;">${date}</div>
          </td>
          <td>
            <div style="font-weight:500;">${o.customer.name}</div>
            <div style="font-size:0.75rem; color:var(--shop-text-sec);">${o.customer.email}</div>
            <div style="font-size:0.75rem; color:var(--shop-text-sec);">${o.customer.phone}</div>
          </td>
          <td style="font-size:0.85rem; line-height:1.4;">${itemsText}</td>
          <td style="font-weight:600; color:var(--shop-accent);">$${o.total.toLocaleString()}</td>
          <td>
            <select onchange="window.appActions.updateOrderState('${id}', this.value)" class="status-select">
              <option value="Pendiente" ${o.status === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
              <option value="Enviado" ${o.status === 'Enviado' ? 'selected' : ''}>Enviado</option>
              <option value="Entregado" ${o.status === 'Entregado' ? 'selected' : ''}>Entregado</option>
            </select>
          </td>
        </tr>
      `;
    });
    ordersBody.innerHTML = html;
  });

  const products = await getProducts();
  const inventoryBody = document.getElementById('admin-inventory-rows');
  const countProductsEl = document.getElementById('stat-products-count');
  
  if (inventoryBody) {
    countProductsEl.textContent = products.length;
    
    let html = '';
    products.forEach(p => {
      html += `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:1rem;">
              <img src="${p.image}" style="width:40px; height:50px; object-fit:cover; border:var(--shop-border);">
              <span style="font-weight:600; font-family:var(--shop-font-title); text-transform:uppercase;">${p.name}</span>
            </div>
          </td>
          <td>${p.category}</td>
          <td style="font-weight:500;">$${p.price.toLocaleString()}</td>
          <td>
            <div class="stock-manager">
              <input type="number" id="stock-input-${p.id}" value="${p.stock}" min="0" class="stock-input">
            </div>
          </td>
          <td>
            <button onclick="window.appActions.adminUpdateStock('${p.id}')" class="stock-update-btn">Actualizar</button>
          </td>
        </tr>
      `;
    });
    inventoryBody.innerHTML = html;
  }
}

// 6. SPA Routing & Switcher
function updateActiveNav(hash) {
  // Original navigation list is menu__link
  document.querySelectorAll('.menu__link').forEach(link => {
    const route = link.getAttribute('href');
    // Normalize hash paths
    if (hash === route || (hash === '#/' && route === '#') || (hash === '#/' && route === '#/')) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });

  // Retract mobile hamburger menu and release body scroll locks
  document.documentElement.removeAttribute('data-fls-menu-open');
  if (typeof window.bodyUnlock === 'function') {
    window.bodyUnlock(400);
  }
}

async function handleRouting() {
  const hash = window.location.hash || '#/';
  const homeView = document.querySelector('main.page.page--home');
  const footerElement = document.querySelector('footer.footer');
  const spaViewport = document.getElementById('spa-viewport');
  
  if (!spaViewport) return;

  // 1. Home Storytelling Route (show original landing, hide SPA)
  if (hash === '#/' || hash === '' || hash === '#home') {
    // Hide SPA container
    spaViewport.classList.remove('active');
    setTimeout(() => {
      spaViewport.style.display = 'none';
      
      // Restore original view layout
      if (homeView) homeView.style.display = 'block';
      if (footerElement) footerElement.style.display = 'block';
      
      // Trigger GSAP ScrollTrigger to recalculate layout offsets on next frame
      window.dispatchEvent(new Event('resize'));
      if (window.ScrollTrigger) {
        window.ScrollTrigger.refresh();
      }
    }, 200);

    updateActiveNav('#/');
    return;
  }

  // 2. E-Commerce Routes (hide original landing, show SPA)
  if (homeView) homeView.style.display = 'none';
  if (footerElement) footerElement.style.display = 'none';
  
  spaViewport.style.display = 'block';
  
  // Trigger transition fade-in
  setTimeout(() => {
    spaViewport.classList.add('active');
  }, 50);

  // Mount views
  if (hash === '#/shop') {
    await templates.shop(spaViewport);
  } else if (hash.startsWith('#/product/')) {
    const productId = hash.split('#/product/')[1];
    await templates.product(spaViewport, productId);
  } else if (hash === '#/admin') {
    await templates.admin(spaViewport);
  } else {
    window.location.hash = '#/';
    return;
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
  updateActiveNav(hash);
}

// 7. Global Actions
window.appActions = {
  addProductToCart: async (id) => {
    const p = await getProductById(id);
    if (p) addToCart(p);
  },
  checkout: () => {
    openCheckoutModal();
  },
  adminLogout: () => {
    if (useMockData) {
      localStorage.removeItem('mock_user');
      showToast("Sesión de Demo finalizada.");
      handleRouting();
    } else {
      auth.signOut().then(() => {
        showToast("Sesión cerrada.");
        handleRouting();
      });
    }
  },
  adminUpdateStock: async (id) => {
    const input = document.getElementById(`stock-input-${id}`);
    if (!input) return;
    const newStock = input.value;
    const success = await updateProductStock(id, newStock);
    if (success) {
      showToast("Stock de inventario actualizado.");
    } else {
      showToast("Error al actualizar inventario.", true);
    }
  },
  updateOrderState: async (id, status) => {
    const success = await updateOrderStatus(id, status);
    if (success) {
      showToast(`Estado de orden actualizado a ${status}.`);
    } else {
      showToast("Error al cambiar estado de la orden.", true);
    }
  }
};

// 8. Event Bindings
window.addEventListener('hashchange', handleRouting);
window.addEventListener('DOMContentLoaded', () => {
  // Let the original GSAP scripts finish rendering before listening to routes
  setTimeout(() => {
    handleRouting();
  }, 100);
  
  updateCartUI();

  // Register PWA Service Worker
  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker registered. Scope: ', reg.scope))
        .catch(err => console.error('Service Worker registration failed: ', err));
    });
  }
});

// Watch scrolling to adapt custom cart button in header
window.addEventListener('scroll', () => {
  const header = document.querySelector('header.header');
  if (header) {
    if (window.scrollY > 50) {
      header.classList.add('header-scrolled');
    } else {
      header.classList.remove('header-scrolled');
    }
  }
});

window.router = handleRouting;
