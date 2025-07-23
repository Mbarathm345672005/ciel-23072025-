const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const nodemailer = require("nodemailer");
const fs = require("fs");
const { google } = require("googleapis");
require("dotenv").config();

// 🔐 Load Google Drive credentials
const CREDENTIALS = require("./impactful-yeti-466710-a9-ec43583c077c.json");

const auth = new google.auth.GoogleAuth({
  credentials: CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const driveService = google.drive({ version: "v3", auth });
const SHARED_DRIVE_FOLDER_ID = "0AA2SQWfLCDNRUk9PVA"; // ✅ Your shared drive ID

// OTP Store and generator
const otpStore = {};
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// File storage for PDF only
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const fileFilter = (req, file, cb) => {
  if (path.extname(file.originalname).toLowerCase() === ".pdf") {
    cb(null, true);
  } else {
    cb(new Error("Only PDF files are allowed"), false);
  }
};
const upload = multer({ storage, fileFilter });

const app = express();
const PORT = 3000;

app.use("/uploads", express.static("uploads"));
app.use(express.static("checkstatus"));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

// MySQL DB connection
const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "mbarath@2005",
  database: "contract_db",
});

// Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// OTP
app.post("/send-otp", async (req, res) => {
  const { username, email } = req.body;
  try {
    if (username && email) {
      const [rows] = await db.execute(
        "SELECT * FROM users WHERE username = ? AND email = ?",
        [username, email]
      );
      if (rows.length === 0) {
        return res.status(400).json({ message: "Username and email do not match" });
      }
    }

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const otp = generateOtp();
    otpStore[email] = otp;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is: ${otp}`,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ OTP sent to ${email}: ${otp}`);
    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("❌ Error in send-otp route:", err.message);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

app.post("/verify-otp", (req, res) => {
  const { email, enteredOtp } = req.body;
  const validOtp = otpStore[email];

  if (enteredOtp === validOtp) {
    delete otpStore[email];
    res.json({ message: "OTP verified successfully" });
  } else {
    res.status(400).json({ message: "Invalid OTP" });
  }
});

// Upload to Drive
app.post("/upload", upload.single("file"), async (req, res) => {
  const { uploadedBy } = req.body;
  const documentName = req.file.originalname;
  const localPath = req.file.path;

  try {
    const fileMetadata = {
      name: `${Date.now()}-${documentName}`,
      parents: [SHARED_DRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: "application/pdf",
      body: fs.createReadStream(localPath),
    };
    const driveResponse = await driveService.files.create({
      resource: fileMetadata,
      media,
      fields: "id",
      supportsAllDrives: true,
    });

    await driveService.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });

    const documentLink = `https://drive.google.com/uc?id=${driveResponse.data.id}`;

    await db.execute(
      `INSERT INTO documents 
      (document_name, document_link, uploaded_by, upload_time, approval_status, review_status) 
      VALUES (?, ?, ?, NOW(), ?, ?)`,
      [documentName, documentLink, uploadedBy, "Pending", "Pending"]
    );

    await sendEmailNotification({ documentName, uploadedBy, documentLink });

    fs.unlinkSync(localPath);

    res.json({ success: true, message: "Document uploaded to Google Drive and saved" });
  } catch (err) {
    console.error("upload error:", err);
    res.status(500).json({ error: "Document upload failed", detail: err.message });
  }
});

// Send document email
async function sendEmailNotification({ documentName, uploadedBy, documentLink }) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.APPROVER_EMAIL,
    subject: "📄 New Document Uploaded for Review",
    html: `
      <h3>A new document has been uploaded.</h3>
      <p><strong>Uploaded By:</strong> ${uploadedBy}</p>
      <p><strong>Document:</strong> ${documentName}</p>
      <p><strong>Link:</strong> <a href="${documentLink}">Download PDF</a></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent to approver.");
  } catch (err) {
    console.error("❌ Failed to send email:", err.message);
  }
}

app.put("/api/review", async (req, res) => {
  const { uploaded_by, review_status, reviewer } = req.body;
  const review_time = new Date();

  try {
    await db.execute(
      `UPDATE documents 
       SET review_status = ?, reviewer = ?, review_time = ? 
       WHERE uploaded_by = ? AND approval_status = 'Approved'`,
      [review_status, reviewer, review_time, uploaded_by]
    );

    const [userRows] = await db.execute("SELECT email FROM users WHERE username = ?", [uploaded_by]);
    const senderEmail = userRows.length ? userRows[0].email : null;
    const approverEmail = process.env.APPROVER_EMAIL;

    const subject =
      review_status === "Approved"
        ? "✅ Document Reviewed & Approved"
        : "❌ Document Reviewed & Rejected";

    const html = `
      <h3>Document reviewed by: ${reviewer}</h3>
      <p><strong>Status:</strong> ${review_status}</p>
      <p><strong>Uploaded By:</strong> ${uploaded_by}</p>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: [senderEmail, approverEmail],
      subject,
      html,
    });

    res.json({ message: "Review status updated and notification sent." });
  } catch (err) {
    console.error("DB Error:", err);
    res.status(500).json({ error: "Failed to update review status." });
  }
});

// Signup
app.post("/api/signup", async (req, res) => {
  const { first_name, last_name, username, email, password, phone } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute(
      "INSERT INTO users (first_name, last_name, username, email, password, phone) VALUES (?, ?, ?, ?, ?, ?)",
      [first_name, last_name, username, email, hashedPassword, phone]
    );
    res.json({ message: "Account created successfully" });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(400).json({ message: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [results] = await db.execute("SELECT * FROM users WHERE username = ?", [username]);
    if (results.length === 0) return res.status(401).json({ message: "User not found" });

    const match = await bcrypt.compare(password, results[0].password);
    if (!match) return res.status(401).json({ message: "Incorrect password" });

    res.json({
      message: "Login successful",
      user: {
        username: results[0].username,
        role: results[0].role,
      },
    });
  } catch (err) {
    res.status(500).send(err);
  }
});

// Admin login
app.post("/admin-login", async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await db.execute("SELECT * FROM admins WHERE username = ?", [username]);
  if (rows.length && rows[0].password === password) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid admin credentials" });
  }
});

// Password reset
app.post("/reset-password", async (req, res) => {
  const { username, email, newPassword } = req.body;
  const hashed = await bcrypt.hash(newPassword, 10);

  try {
    const [result] = await db.execute(
      `UPDATE users SET password = ? WHERE username = ? AND email = ?`,
      [hashed, username, email]
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ message: "User not found or email does not match" });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ message: "Error resetting password" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/checkstatus/homepage.html");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
