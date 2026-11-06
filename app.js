// ===== 商品資料 =====
const PRODUCTS = [
  { id: 1, name: "手作陶瓷咖啡杯", cat: "餐廚", price: 680, old: 850, rating: 4.8, reviews: 126, emoji: "☕", bg: "linear-gradient(145deg,#eef2ff,#dfe5ff)", tag: "sale" },
  { id: 2, name: "大豆香氛蠟燭", cat: "香氛", price: 520, rating: 4.9, reviews: 302, emoji: "🕯️", bg: "linear-gradient(145deg,#fff7ed,#fde8cc)", tag: "hot" },
  { id: 3, name: "亞麻抱枕套", cat: "家居", price: 450, rating: 4.6, reviews: 88, emoji: "🛋️", bg: "linear-gradient(145deg,#f5f3ff,#e8e2ff)" },
  { id: 4, name: "迷你多肉盆栽", cat: "植栽", price: 350, rating: 4.7, reviews: 214, emoji: "🌵", bg: "linear-gradient(145deg,#ecfdf5,#d3f3e4)", tag: "new" },
  { id: 5, name: "木質餐盤組", cat: "餐廚", price: 990, old: 1200, rating: 4.5, reviews: 67, emoji: "🍽️", bg: "linear-gradient(145deg,#fdf2f8,#fadcec)", tag: "sale" },
  { id: 6, name: "精油擴香瓶", cat: "香氛", price: 780, rating: 4.8, reviews: 145, emoji: "🌸", bg: "linear-gradient(145deg,#fdf4ff,#f3dcfa)" },
  { id: 7, name: "編織收納籃", cat: "家居", price: 620, rating: 4.4, reviews: 53, emoji: "🧺", bg: "linear-gradient(145deg,#fffbeb,#fcecc2)", tag: "new" },
  { id: 8, name: "琴葉榕盆栽", cat: "植栽", price: 1280, rating: 4.9, reviews: 98, emoji: "🪴", bg: "linear-gradient(145deg,#f0fdf4,#d5f2df)" },
  { id: 9, name: "手沖咖啡壺", cat: "餐廚", price: 1450, rating: 4.7, reviews: 176, emoji: "🫖", bg: "linear-gradient(145deg,#f0f9ff,#d8ecfd)" },
  { id: 10, name: "羊毛毯", cat: "家居", price: 1680, old: 1980, rating: 4.8, reviews: 121, emoji: "🧶", bg: "linear-gradient(145deg,#eef2ff,#e2defc)", tag: "sale" },
  { id: 11, name: "茶香擴香石", cat: "香氛", price: 390, rating: 4.3, reviews: 41, emoji: "🍃", bg: "linear-gradient(145deg,#f7fee7,#e4f4cb)" },
  { id: 12, name: "玻璃水耕花瓶", cat: "植栽", price: 560, rating: 4.6, reviews: 72, emoji: "💐", bg: "linear-gradient(145deg,#ecfeff,#d0f0f6)", tag: "new" },
];

const FREE_SHIPPING = 1500;
const SHIPPING_FEE = 80;
const COUPONS = { GROVE10: 0.1 };

// ===== 工具 =====
const $ = (s) => document.querySelector(s);
const fmt = (n) => "NT$" + Math.round(n).toLocaleString("en-US");
const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// ===== 狀態 =====
const state = {
  category: "全部",
  query: "",
  sort: "default",
  cart: storage.get("mg-cart", {}), // { [id]: qty }
  coupon: storage.get("mg-coupon", null),
};

// ===== 商品列表 =====
function renderFilters() {
  const cats = ["全部", ...new Set(PRODUCTS.map((p) => p.cat))];
  $("#filters").innerHTML = cats
    .map((c) => `<button class="chip ${c === state.category ? "active" : ""}" data-cat="${c}">${c}</button>`)
    .join("");
}

function getVisibleProducts() {
  let list = PRODUCTS.filter(
    (p) =>
      (state.category === "全部" || p.cat === state.category) &&
      p.name.toLowerCase().includes(state.query.toLowerCase())
  );
  const sorters = {
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    rating: (a, b) => b.rating - a.rating,
  };
  if (sorters[state.sort]) list = [...list].sort(sorters[state.sort]);
  return list;
}

function badgeHTML(p) {
  if (p.tag === "sale") return `<span class="badge">-${Math.round((1 - p.price / p.old) * 100)}%</span>`;
  if (p.tag === "new") return `<span class="badge badge--new">NEW</span>`;
  if (p.tag === "hot") return `<span class="badge badge--hot">熱銷</span>`;
  return "";
}

function renderProducts() {
  const list = getVisibleProducts();
  $("#emptyMsg").hidden = list.length > 0;
  $("#productGrid").innerHTML = list
    .map(
      (p) => `
      <article class="card">
        <div class="card__img" style="background:${p.bg}">${p.emoji}${badgeHTML(p)}</div>
        <div class="card__body">
          <span class="card__cat">${p.cat}</span>
          <h3 class="card__title">${p.name}</h3>
          <div class="card__rating">★ ${p.rating} <span>(${p.reviews})</span></div>
          <div class="card__price">
            <span class="price">${fmt(p.price)}</span>
            ${p.old ? `<span class="price--old">${fmt(p.old)}</span>` : ""}
          </div>
          <button class="btn btn--primary btn--block" data-add="${p.id}">加入購物車</button>
        </div>
      </article>`
    )
    .join("");
}

// ===== 購物車 =====
const findProduct = (id) => PRODUCTS.find((p) => p.id === Number(id));

function cartTotals() {
  const subtotal = Object.entries(state.cart).reduce((sum, [id, qty]) => sum + findProduct(id).price * qty, 0);
  const discount = state.coupon ? subtotal * COUPONS[state.coupon] : 0;
  const afterDiscount = subtotal - discount;
  const shipping = subtotal === 0 || afterDiscount >= FREE_SHIPPING ? 0 : SHIPPING_FEE;
  return { subtotal, discount, shipping, total: afterDiscount + shipping, afterDiscount };
}

function saveCart() {
  storage.set("mg-cart", state.cart);
  storage.set("mg-coupon", state.coupon);
}

function addToCart(id) {
  state.cart[id] = (state.cart[id] || 0) + 1;
  saveCart();
  renderCart();
  const badge = $("#cartCount");
  badge.classList.remove("bump");
  void badge.offsetWidth;
  badge.classList.add("bump");
  toast(`已加入「${findProduct(id).name}」`);
}

function changeQty(id, delta) {
  state.cart[id] = (state.cart[id] || 0) + delta;
  if (state.cart[id] <= 0) delete state.cart[id];
  saveCart();
  renderCart();
}

function renderCart() {
  const entries = Object.entries(state.cart);
  const count = entries.reduce((s, [, q]) => s + q, 0);
  $("#cartCount").textContent = count;

  $("#cartItems").innerHTML = entries.length
    ? entries
        .map(([id, qty]) => {
          const p = findProduct(id);
          return `
          <div class="cart-item">
            <div class="cart-item__img" style="background:${p.bg}">${p.emoji}</div>
            <div>
              <div class="cart-item__name">${p.name}</div>
              <div class="cart-item__price">${fmt(p.price)} × ${qty}</div>
              <div class="qty">
                <button data-qty="${id}" data-delta="-1" aria-label="減少">−</button>
                <span>${qty}</span>
                <button data-qty="${id}" data-delta="1" aria-label="增加">+</button>
              </div>
            </div>
            <div style="text-align:right">
              <div><b>${fmt(p.price * qty)}</b></div>
              <button class="remove" data-remove="${id}">移除</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="cart-empty">🛍️<br />購物車是空的</div>`;

  const t = cartTotals();
  $("#subtotal").textContent = fmt(t.subtotal);
  $("#discountRow").hidden = !t.discount;
  $("#discount").textContent = "-" + fmt(t.discount);
  $("#shipping").textContent = t.shipping ? fmt(t.shipping) : "免運";
  $("#total").textContent = fmt(t.total);
  $("#freeHint").textContent =
    t.subtotal === 0 ? "" : t.afterDiscount >= FREE_SHIPPING ? "🎉 已達免運門檻！" : `再買 ${fmt(FREE_SHIPPING - t.afterDiscount)} 即可免運`;
  $("#checkoutBtn").disabled = entries.length === 0;
  $("#couponInput").value = state.coupon || "";
}

function openCart() {
  $("#drawer").classList.add("open");
  $("#overlay").hidden = false;
}
function closeCart() {
  $("#drawer").classList.remove("open");
  $("#overlay").hidden = true;
}

// ===== 結帳 =====
function openCheckout() {
  closeCart();
  $("#modalTotal").textContent = fmt(cartTotals().total);
  $("#checkoutStep").hidden = false;
  $("#successStep").hidden = true;
  $("#formError").textContent = "";
  $("#checkoutModal").hidden = false;
}
function closeCheckout() {
  $("#checkoutModal").hidden = true;
}

function submitOrder(e) {
  e.preventDefault();
  const form = e.target;
  let valid = true;
  [...form.elements].forEach((el) => {
    if (!el.willValidate) return;
    const ok = el.checkValidity();
    el.classList.toggle("invalid", !ok);
    if (!ok) valid = false;
  });
  if (!valid) {
    $("#formError").textContent = "請確認標示紅框的欄位（手機格式：09 開頭共 10 碼）";
    return;
  }
  $("#orderId").textContent = "MG" + Date.now().toString().slice(-8);
  state.cart = {};
  state.coupon = null;
  saveCart();
  renderCart();
  form.reset();
  $("#checkoutStep").hidden = true;
  $("#successStep").hidden = false;
}

// ===== Toast =====
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// ===== 事件 =====
$("#filters").addEventListener("click", (e) => {
  const cat = e.target.dataset.cat;
  if (!cat) return;
  state.category = cat;
  renderFilters();
  renderProducts();
});
$("#search").addEventListener("input", (e) => {
  state.query = e.target.value.trim();
  renderProducts();
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderProducts();
});
$("#productGrid").addEventListener("click", (e) => {
  const id = e.target.dataset.add;
  if (id) addToCart(id);
});
$("#cartItems").addEventListener("click", (e) => {
  const { qty, delta, remove } = e.target.dataset;
  if (qty) changeQty(qty, Number(delta));
  if (remove) changeQty(remove, -Infinity);
});
$("#couponBtn").addEventListener("click", () => {
  const code = $("#couponInput").value.trim().toUpperCase();
  if (!code) {
    state.coupon = null;
    toast("已移除優惠碼");
  } else if (COUPONS[code]) {
    state.coupon = code;
    toast(`已套用 ${code}，享 ${(1 - COUPONS[code]) * 10} 折優惠`);
  } else {
    toast("優惠碼無效");
    return;
  }
  saveCart();
  renderCart();
});
$("#cartOpen").addEventListener("click", openCart);
$("#cartClose").addEventListener("click", closeCart);
$("#overlay").addEventListener("click", closeCart);
$("#checkoutBtn").addEventListener("click", openCheckout);
$("#modalClose").addEventListener("click", closeCheckout);
$("#successClose").addEventListener("click", closeCheckout);
$("#checkoutModal").addEventListener("click", (e) => {
  if (e.target.id === "checkoutModal") closeCheckout();
});
$("#checkoutForm").addEventListener("submit", submitOrder);
$("#menuBtn").addEventListener("click", () => $("#nav").classList.toggle("open"));
$("#nav").addEventListener("click", (e) => {
  if (e.target.tagName === "A") $("#nav").classList.remove("open");
});
$("#newsletterForm").addEventListener("submit", (e) => {
  e.preventDefault();
  e.target.reset();
  toast("訂閱成功，感謝你！💌");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeCart();
    closeCheckout();
  }
});

// ===== 初始化 =====
renderFilters();
renderProducts();
renderCart();
