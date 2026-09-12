import os, sqlite3, hashlib, secrets, requests
from functools import wraps
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, session, flash, jsonify
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-change-me")
DB = os.getenv("DATABASE_PATH", "ala.db")

AIRPORTS = [
("BOG","Bogotá"),("MDE","Medellín"),("CLO","Cali"),("CTG","Cartagena"),
("BAQ","Barranquilla"),("BGA","Bucaramanga"),("PEI","Pereira"),
("SMR","Santa Marta"),("CUC","Cúcuta"),("ADZ","San Andrés"),
("AXM","Armenia"),("MTR","Montería"),("PSO","Pasto"),("MZL","Manizales")
]

def db():
    conn=sqlite3.connect(DB)
    conn.row_factory=sqlite3.Row
    return conn

def hash_pw(password, salt=None):
    salt=salt or secrets.token_hex(16)
    digest=hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 160000).hex()
    return f"{salt}${digest}"

def check_pw(password, stored):
    try:
        salt,digest=stored.split("$",1)
        return secrets.compare_digest(hash_pw(password,salt).split("$",1)[1], digest)
    except Exception:
        return False

def init_db():
    con=db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      whatsapp TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_airports(
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      UNIQUE(user_id,code)
    );
    CREATE TABLE IF NOT EXISTS deals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      destination_country TEXT,
      airline TEXT,
      price_cop INTEGER NOT NULL,
      normal_price_cop INTEGER,
      trip_type TEXT DEFAULT 'Ida y vuelta',
      travel_window TEXT,
      baggage TEXT,
      stops TEXT,
      booking_url TEXT,
      premium INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      checked_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    """)
    count=con.execute("SELECT COUNT(*) c FROM deals").fetchone()["c"]
    if count==0:
        now=datetime.now().isoformat(timespec="minutes")
        samples=[
        ("BOG","Miami","Estados Unidos","Avianca",899000,1450000,"Ida y vuelta","Oct–Nov 2026","Artículo personal","Directo","https://www.google.com/travel/flights",0),
        ("MDE","Madrid","España","Avianca",2190000,3400000,"Ida y vuelta","Feb–May 2027","Equipaje según tarifa","1 escala","https://www.google.com/travel/flights",0),
        ("CLO","Cancún","México","Copa",1090000,1850000,"Ida y vuelta","Nov 2026–Feb 2027","Equipaje según tarifa","1 escala","https://www.google.com/travel/flights",1),
        ("CTG","Medellín","Colombia","JetSMART",189000,420000,"Ida y vuelta","Próximos 60 días","Artículo personal","Directo","https://www.google.com/travel/flights",0),
        ("BAQ","Nueva York","Estados Unidos","Avianca",1490000,2400000,"Ida y vuelta","Ene–Mar 2027","Equipaje según tarifa","1 escala","https://www.google.com/travel/flights",1),
        ("PEI","Punta Cana","Rep. Dominicana","Avianca",1290000,2100000,"Ida y vuelta","Ene–Abr 2027","Equipaje según tarifa","1 escala","https://www.google.com/travel/flights",0)
        ]
        for s in samples:
            con.execute("""INSERT INTO deals(origin,destination,destination_country,airline,price_cop,normal_price_cop,trip_type,travel_window,baggage,stops,booking_url,premium,checked_at,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (*s,now,now))
    con.commit(); con.close()

def login_required(fn):
    @wraps(fn)
    def w(*a,**k):
        if not session.get("uid"): return redirect(url_for("login"))
        return fn(*a,**k)
    return w

def admin_required(fn):
    @wraps(fn)
    def w(*a,**k):
        if session.get("email") != os.getenv("ADMIN_EMAIL","admin@example.com"):
            flash("Acceso de administrador requerido.")
            return redirect(url_for("index"))
        return fn(*a,**k)
    return w

def money(n):
    try:return "${:,.0f}".format(int(n)).replace(",",".")
    except:return "$0"

app.jinja_env.filters["cop"]=money

@app.route("/")
def index():
    con=db()
    origins=[r["origin"] for r in con.execute("SELECT DISTINCT origin FROM deals WHERE active=1 ORDER BY origin")]
    q="SELECT * FROM deals WHERE active=1"
    args=[]
    origin=request.args.get("origin","").strip()
    if origin:
        q+=" AND origin=?"; args.append(origin)
    q+=" ORDER BY created_at DESC"
    deals=con.execute(q,args).fetchall()
    con.close()
    return render_template("index.html",deals=deals,airports=AIRPORTS,selected_origin=origin)

@app.route("/register",methods=["GET","POST"])
def register():
    if request.method=="POST":
        email=request.form["email"].strip().lower()
        pw=request.form["password"]
        if len(pw)<8:
            flash("Usa una contraseña de al menos 8 caracteres."); return redirect(url_for("register"))
        try:
            con=db()
            cur=con.execute("INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)",
                            (email,hash_pw(pw),datetime.now().isoformat()))
            con.commit()
            uid=cur.lastrowid
            con.close()
            session.update(uid=uid,email=email)
            return redirect(url_for("profile"))
        except sqlite3.IntegrityError:
            flash("Ese correo ya está registrado.")
    return render_template("auth.html",mode="register")

@app.route("/login",methods=["GET","POST"])
def login():
    if request.method=="POST":
        email=request.form["email"].strip().lower()
        con=db(); u=con.execute("SELECT * FROM users WHERE email=?",(email,)).fetchone(); con.close()
        admin_email=os.getenv("ADMIN_EMAIL","admin@example.com").lower()
        admin_pass=os.getenv("ADMIN_PASSWORD","change-me-now")
        if email==admin_email and request.form["password"]==admin_pass:
            session.update(uid=-1,email=email,plan="premium_plus")
            return redirect(url_for("admin"))
        if u and check_pw(request.form["password"],u["password_hash"]):
            session.update(uid=u["id"],email=u["email"],plan=u["plan"])
            return redirect(url_for("profile"))
        flash("Correo o contraseña incorrectos.")
    return render_template("auth.html",mode="login")

@app.route("/logout")
def logout():
    session.clear(); return redirect(url_for("index"))

@app.route("/profile",methods=["GET","POST"])
@login_required
def profile():
    if session["uid"] == -1: return redirect(url_for("admin"))
    con=db()
    if request.method=="POST":
        whatsapp=request.form.get("whatsapp","").strip()
        selected=request.form.getlist("airports")
        con.execute("UPDATE users SET whatsapp=? WHERE id=?",(whatsapp,session["uid"]))
        con.execute("DELETE FROM user_airports WHERE user_id=?",(session["uid"],))
        for code in selected[:14]:
            con.execute("INSERT OR IGNORE INTO user_airports(user_id,code) VALUES(?,?)",(session["uid"],code))
        con.commit(); flash("Preferencias guardadas.")
    u=con.execute("SELECT * FROM users WHERE id=?",(session["uid"],)).fetchone()
    prefs={r["code"] for r in con.execute("SELECT code FROM user_airports WHERE user_id=?",(session["uid"],))}
    con.close()
    return render_template("profile.html",u=u,prefs=prefs,airports=AIRPORTS)

@app.route("/pricing")
def pricing(): return render_template("pricing.html")

@app.route("/upgrade/<plan>")
@login_required
def upgrade(plan):
    if plan not in ("premium","premium_plus"): return redirect(url_for("pricing"))
    # Demo upgrade for local MVP. Replace this with Wompi checkout + signed webhook in production.
    if session["uid"] != -1:
        con=db(); con.execute("UPDATE users SET plan=? WHERE id=?",(plan,session["uid"])); con.commit(); con.close()
        session["plan"]=plan
        flash("MODO DEMO: tu plan fue actualizado. En producción, este paso ocurre solo después de confirmación de Wompi.")
    return redirect(url_for("profile"))

@app.route("/deal/<int:deal_id>")
def deal(deal_id):
    con=db(); d=con.execute("SELECT * FROM deals WHERE id=? AND active=1",(deal_id,)).fetchone(); con.close()
    if not d: return ("No encontrada",404)
    if d["premium"] and session.get("plan","free")=="free" and session.get("email")!=os.getenv("ADMIN_EMAIL",""):
        flash("Esta oferta es exclusiva para miembros Premium.")
        return redirect(url_for("pricing"))
    return redirect(d["booking_url"] or url_for("index"))

@app.route("/admin")
@admin_required
def admin():
    con=db()
    deals=con.execute("SELECT * FROM deals ORDER BY created_at DESC").fetchall()
    users=con.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
    con.close()
    return render_template("admin.html",deals=deals,users=users)

@app.route("/admin/deal",methods=["POST"])
@admin_required
def add_deal():
    f=request.form; now=datetime.now().isoformat(timespec="minutes")
    con=db()
    con.execute("""INSERT INTO deals(origin,destination,destination_country,airline,price_cop,normal_price_cop,trip_type,travel_window,baggage,stops,booking_url,premium,checked_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
    (f["origin"],f["destination"],f.get("destination_country"),f.get("airline"),int(f["price_cop"]),
     int(f.get("normal_price_cop") or 0),f.get("trip_type","Ida y vuelta"),f.get("travel_window"),
     f.get("baggage"),f.get("stops"),f.get("booking_url"),1 if f.get("premium") else 0,now,now))
    deal_id=con.execute("SELECT last_insert_rowid() id").fetchone()["id"]; con.commit()
    subscribers=con.execute("""SELECT u.* FROM users u LEFT JOIN user_airports a ON a.user_id=u.id
      WHERE (a.code=? OR NOT EXISTS(SELECT 1 FROM user_airports x WHERE x.user_id=u.id))
      GROUP BY u.id""",(f["origin"],)).fetchall()
    con.close()
    for u in subscribers:
        send_alert(u, f["origin"], f["destination"], int(f["price_cop"]), deal_id)
    flash(f"Oferta publicada y procesada para {len(subscribers)} suscriptores.")
    return redirect(url_for("admin"))

@app.route("/admin/deal/<int:deal_id>/toggle",methods=["POST"])
@admin_required
def toggle_deal(deal_id):
    con=db(); con.execute("UPDATE deals SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?",(deal_id,)); con.commit(); con.close()
    return redirect(url_for("admin"))

def send_alert(user, origin, destination, price, deal_id):
    subject=f"🔥 {origin} → {destination} por {money(price)} COP"
    html=f"""<h2>{subject}</h2><p>Encontramos una nueva oferta.</p>
    <p><a href="{request.url_root.rstrip('/')}{url_for('deal',deal_id=deal_id)}">Ver oferta</a></p>"""
    key=os.getenv("RESEND_API_KEY")
    if key:
        try:
            requests.post("https://api.resend.com/emails",
              headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"},
              json={"from":os.getenv("FROM_EMAIL","onboarding@resend.dev"),"to":[user["email"]],
                    "subject":subject,"html":html},timeout=15)
        except Exception as e: print("Email error:",e)
    else: print("EMAIL DEMO:",user["email"],subject)

    token=os.getenv("WHATSAPP_TOKEN"); phone_id=os.getenv("WHATSAPP_PHONE_NUMBER_ID")
    if token and phone_id and user["whatsapp"] and user["plan"]=="premium_plus":
        try:
            requests.post(f"https://graph.facebook.com/v22.0/{phone_id}/messages",
              headers={"Authorization":f"Bearer {token}","Content-Type":"application/json"},
              json={"messaging_product":"whatsapp","to":user["whatsapp"],"type":"text",
                    "text":{"body":subject}},timeout=15)
        except Exception as e: print("WhatsApp error:",e)

@app.route("/health")
def health(): return jsonify(status="ok",service="ALA")

# Ensure tables exist when imported by Gunicorn / a hosting platform.
init_db()

if __name__=="__main__":
    app.run(debug=True)
