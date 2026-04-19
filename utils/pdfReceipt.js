const PDFDocument = require('pdfkit');

const generateReceiptPDF = (receiptData) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const d = receiptData;
      const pageWidth = doc.page.width - 100;

      // Header - Academy Info
      doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e1b4b')
         .text(d.academy_name || 'Academy', 50, 50);
      doc.fontSize(9).font('Helvetica').fillColor('#666')
         .text([d.academy_address, d.academy_phone, d.academy_email].filter(Boolean).join(' | '), 50, 75);

      // Receipt title
      doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e5e7eb').stroke();
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#111')
         .text('FEE RECEIPT', 50, 115, { align: 'center' });
      doc.moveTo(50, 140).lineTo(545, 140).strokeColor('#e5e7eb').stroke();

      // Receipt meta
      const metaY = 155;
      doc.fontSize(10).font('Helvetica').fillColor('#555');
      doc.text('Receipt No:', 50, metaY);
      doc.font('Helvetica-Bold').fillColor('#111').text(d.receipt_number || 'N/A', 140, metaY);
      doc.font('Helvetica').fillColor('#555').text('Date:', 350, metaY);
      doc.font('Helvetica-Bold').fillColor('#111')
         .text(new Date(d.payment_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }), 390, metaY);

      // Student Info Box
      const boxY = 190;
      doc.roundedRect(50, boxY, pageWidth, 70, 5).fillColor('#f9fafb').fill();
      doc.fontSize(10).font('Helvetica').fillColor('#555');
      doc.text('Student Name:', 65, boxY + 12);
      doc.font('Helvetica-Bold').fillColor('#111').text(d.student_name, 160, boxY + 12);
      doc.font('Helvetica').fillColor('#555').text('Phone:', 65, boxY + 30);
      doc.fillColor('#111').text(d.student_phone || '', 160, boxY + 30);
      doc.font('Helvetica').fillColor('#555').text('Course:', 65, boxY + 48);
      doc.fillColor('#111').text(d.course_name || '', 160, boxY + 48);
      if (d.student_email) {
        doc.font('Helvetica').fillColor('#555').text('Email:', 350, boxY + 12);
        doc.fillColor('#111').text(d.student_email, 400, boxY + 12);
      }

      // Fee Details Table
      const tableY = 285;
      // Table header
      doc.roundedRect(50, tableY, pageWidth, 28, 3).fillColor('#4f46e5').fill();
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff');
      doc.text('Description', 65, tableY + 8);
      doc.text('Amount', 430, tableY + 8, { align: 'right', width: 100 });

      // Table rows
      let rowY = tableY + 35;
      const drawRow = (label, amount, bold = false) => {
        doc.fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#333');
        doc.text(label, 65, rowY);
        doc.text(`₹${parseFloat(amount).toLocaleString('en-IN')}`, 430, rowY, { align: 'right', width: 100 });
        rowY += 22;
      };

      drawRow('Total Fee', d.total_fee);
      if (parseFloat(d.discount) > 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#16a34a');
        doc.text('Discount', 65, rowY);
        doc.text(`-₹${parseFloat(d.discount).toLocaleString('en-IN')}`, 430, rowY, { align: 'right', width: 100 });
        rowY += 22;
      }

      // Separator
      doc.moveTo(65, rowY).lineTo(530, rowY).strokeColor('#e5e7eb').stroke();
      rowY += 8;
      drawRow('Net Fee', d.net_fee, true);

      // Separator
      doc.moveTo(65, rowY).lineTo(530, rowY).strokeColor('#e5e7eb').stroke();
      rowY += 8;

      // Payment amount highlight
      doc.roundedRect(50, rowY, pageWidth, 35, 5).fillColor('#f0fdf4').fill();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#16a34a');
      doc.text('Amount Paid', 65, rowY + 10);
      doc.text(`₹${parseFloat(d.amount).toLocaleString('en-IN')}`, 430, rowY + 10, { align: 'right', width: 100 });
      rowY += 45;

      // Payment mode
      doc.fontSize(10).font('Helvetica').fillColor('#555');
      doc.text(`Payment Mode: ${(d.payment_mode || 'cash').replace(/_/g, ' ').toUpperCase()}`, 65, rowY);
      rowY += 20;

      // Balance
      const balance = parseFloat(d.balance || 0);
      if (balance > 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#dc2626');
        doc.text(`Remaining Balance: ₹${balance.toLocaleString('en-IN')}`, 65, rowY);
      } else {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#16a34a');
        doc.text('✓ Fully Paid', 65, rowY);
      }
      rowY += 30;

      // Received by
      if (d.received_by_name) {
        doc.fontSize(9).font('Helvetica').fillColor('#999');
        doc.text(`Received by: ${d.received_by_name}`, 65, rowY);
      }

      // Footer
      const footerY = doc.page.height - 80;
      doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor('#e5e7eb').stroke();
      doc.fontSize(8).font('Helvetica').fillColor('#999');
      doc.text('This is a computer-generated receipt and does not require a signature.', 50, footerY + 10, { align: 'center' });
      doc.text(`Generated by CurveLead — Academy Management Platform`, 50, footerY + 24, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

module.exports = { generateReceiptPDF };
