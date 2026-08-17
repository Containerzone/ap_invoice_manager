# Accounts Receivable SOP — Purchase Orders and Container Services

| Document control | Detail |
|---|---|
| **Document owner** | Accounts Receivable Manager |
| **Applies to** | Accounts Receivable, Operations, Container Control and Finance/AP |
| **Version** | 1.0 — 18 August 2026 |
| **Systems** | Vtiger Deals, Container Control and Xero Purchase Orders |
| **Review point** | Quarterly, and before any new PO prefix, carrier, container acquisition type or cost category is used |

## 1. Purpose and scope

This standard operating procedure defines how the Accounts Receivable (AR) team identifies and controls the Purchase Orders (POs) that support container-transport jobs, container hire and container purchase. It records the approved number structures, prefixes and suffixes, the stage at which the POs are created, and the reconciliation checkpoints needed before customer billing.

> **Key accounting distinction.** A Purchase Order in this process is a supplier-cost commitment and therefore sits on the **accounts-payable** side of the business. AR uses the PO to check job costs, margin and customer-billing readiness. A customer sales invoice remains an Xero `ACCREC` invoice and must never be matched to, or treated as, a supplier PO or supplier bill.[1]

The automated Vtiger-to-Xero process described in Sections 3 and 4 creates operational POs when a Vtiger Deal reaches **Stage 1**. The Container Control process described in Sections 5 and 6 creates container-specific POs after the relevant Container Control (CC) record is created. These are separate, complementary workflows.

## 2. Universal PO-number rules

| Component | Rule | Example |
|---|---|---|
| **Deal ID** | Most operational transport POs derive from the numeric portion of the Vtiger Deal ID. | `D702118` contains the job digits `702118`. |
| **Prefix** | Identifies the service, cost type, carrier or Container Control acquisition category. | `AD`, `P`, `SL`, `A`, `S` |
| **`D` infix** | Most ContainerZone operational service POs insert `D` between the service prefix and the Deal ID digits. | `A` + `D` + `702118` = `AD702118`. |
| **No-`D` exception** | Pacific National, Straitlink, Tasmanian Railway, Aurizon and Regional Connect do **not** use a `D` infix. | `P702118`, `SL702118`, `TR702118`, `AZ702118`, `RC702118`. |
| **Suffix** | Only the second Hub Transfer uses the configured suffix `-2`; it must be retained. | `TD702118-2`. |
| **CC ID** | Container asset/sale POs use the Container Control record ID, not the Vtiger Deal ID. | CC record `1234` → `A1234` or `S1234`. |

**Never change a prefix, job digits, CC ID or suffix merely to avoid a duplicate.** A duplicate is a control event: review the source deal or Container Control record, the existing Xero PO and the supplier commitment before any correction is made.

## 3. Operational transport PO register — Vtiger Deal Stage 1

The following POs are automatically generated from the current Vtiger cost-field mapping after the Deal Stage 1 trigger. The automation evaluates every mapped field independently. A field that is blank or zero produces no PO; a number already present in Xero is reported as a duplicate and is not created again.[2]

Each generated PO is created as a Xero **Draft**, has one quantity-one line, uses **GST-exclusive** cost, Xero account code **310**, and tax type **INPUT**.[2]

| Service / cost type | Vtiger cost field | Prefix and number rule | Example for `D702118` | Supplier contact in Xero | PO line description |
|---|---|---|---|---|---|
| Empty container delivery | `cf_quotes_emptydelivery` | `AD{deal digits}` | `AD702118` | CONTAINERZONE | Empty Container Delivery |
| Full container collection | `cf_quotes_fullcollection` | `BD{deal digits}` | `BD702118` | CONTAINERZONE | Full Container Collection |
| Pacific National rail | `pn rail cost` | `P{deal digits}` | `P702118` | Pacific National | Pacific National Rail Cost |
| Full container delivery | `fullcontainerdeliveryd` | `DD{deal digits}` | `DD702118` | CONTAINERZONE | Full Container Delivery |
| Empty container dehire | `empty dehire e` | `ED{deal digits}` | `ED702118` | CONTAINERZONE | Empty Container Dehire |
| Straitlink Bass Strait | `straitlinkbassstraight` | `SL{deal digits}` | `SL702118` | Straitlink | Straitlink Bass Straight |
| Tasmanian rail | `tasmanianrail` | `TR{deal digits}` | `TR702118` | Tasmanian Railway | Tasmanian Rail Cost |
| Aurizon rail | `aurizon rail` | `AZ{deal digits}` | `AZ702118` | Aurizon | Aurizon Rail Cost |
| Hub transfer — first leg | `hub transfrer t` | `TD{deal digits}` | `TD702118` | CONTAINERZONE | Hub Transfer |
| Hub transfer — second leg | `hub transfrer t2` | `TD{deal digits}-2` | `TD702118-2` | CONTAINERZONE | Hub Transfer 2 |
| Regional Connect | `regional connect` | `RC{deal digits}` | `RC702118` | CONTAINERZONE | Regional Connect |
| Transport to storage | `transport to storage` | `JD{deal digits}` | `JD702118` | CONTAINERZONE | Transport to Storage |
| Storage per week | `storage pw` | `GD{deal digits}` | `GD702118` | CONTAINERZONE | Storage per Week |
| Insurance | `insurance` | `ID{deal digits}` | `ID702118` | CONTAINERZONE | Insurance |

### 3.1 Interpretation of operational prefixes

**AD**, **BD**, **DD** and **ED** represent empty delivery, full collection, full delivery and empty dehire. **P**, **SL**, **TR**, **AZ** and **RC** are carrier/rail service prefixes and deliberately omit the `D` infix. **TD** identifies a hub transfer; the `-2` suffix identifies the second hub-transfer component for the same job. **JD**, **GD** and **ID** identify transport to storage, weekly storage and insurance.

## 4. Operational PO lifecycle and Deal-stage controls

| Stage | Owner | Required action | AR control point |
|---|---|---|---|
| **Quote and deal preparation** | Sales / Operations | Create the Vtiger deal and enter confirmed supplier costs in the relevant mapped fields. | Confirm that the customer quote, job record and eventual customer invoice use the same Deal ID. |
| **Deal Stage 1 — PO trigger** | Operations / Vtiger | Move the deal to Stage 1. The webhook sends the deal data to the PO service. | Confirm expected Draft POs were created for every non-zero operational cost. |
| **Draft PO review** | Operations / Finance/AP | Check supplier, service, PO number, GST-exclusive value and source cost. | Do not regard a Draft PO as final evidence for customer-billing adjustments. |
| **Authorisation** | Finance/AP | Authorise the reviewed PO under the applicable delegation. | Use only authorised supplier-cost information in final margin review. |
| **Supplier invoice / bill conversion** | AP | Match the supplier invoice, then create the bill from the approved PO and mark the PO Billed. | Confirm a Billed PO is never reused and that the customer job still has the intended commercial treatment. |
| **Customer billing and reconciliation** | AR | Issue the customer sales invoice from completed service and agreed customer terms. Reconcile revenue, authorised cost and approved variance. | Record sales as `ACCREC`; do not attach the customer invoice to a supplier PO/bill. |

Operational stage filters are used to avoid displaying completed activities as outstanding. Container sourcing is visible only through **Container Sourcing (stage 2)**. Empty delivery is shown before **Deliver Empty Container (stage 2)**. Full collection remains visible through **stage 6**. Full delivery is visible through **stage 10**, and at stage 11 only when a full-container-delivery date exists. These visibility rules are not a substitute for the PO creation trigger: the automated operational PO trigger itself occurs at **Deal Stage 1**.

### 4.1 Xero status controls

| Xero PO status | Meaning in this SOP | Required AR response |
|---|---|---|
| **DRAFT** | PO has been created but is not final/approved. | Use as a job-cost reference only; do not rely on it for a final customer credit or pricing change. |
| **SUBMITTED / AWAITING APPROVAL** | PO is undergoing financial review, where this intermediary state is used. | Obtain Finance confirmation before using it as an approved cost. |
| **AUTHORISED** | Approved supplier commitment, ready for supplier-bill conversion. | Use in the job margin review when the related service is confirmed. |
| **BILLED** | A supplier bill has been created from the PO. | Treat as closed for supplier-billing purposes and escalate any reuse attempt as duplicate-billing risk. |

The application treats Draft, Submitted and Authorised POs as comparable during invoice verification, requires authorisation before marking a PO Billed, and flags a Billed PO as a duplicate-billing risk.[2] Xero permits bills to be created from approved or billed purchase orders.[3]

## 5. Container Control PO register — hire, purchase, sale and storage

Container Control POs are created from the container acquisition/ownership record, not from the Vtiger Stage 1 transport-cost mapping. They must be raised **after** the Container Control record is created and the commercial/supplier commitment has been approved.

| Container Control category | Creation stage | Number/reference rule | Frequency | Required AR / Finance control |
|---|---|---|---|---|
| **Asset — container purchase from supplier** | Approved Container Purchase quote → CC record created → supplier commitment confirmed | `A{CC ID}` | One-time | Confirm the container type, grade, supplier quotation, ownership/asset treatment, delivery and final supplier bill. Example: CC `1234` → `A1234`. |
| **For Hire — hired container** | Approved Container Hire quote → CC record created → hire commencement and supplier commitment confirmed | Monthly PO against the CC record; use the approved Finance reference for the CC record | Monthly while hired | Reconcile monthly supplier hire cost, customer hire revenue, start/dehire date, minimum term and any damage/detention. |
| **Customer Sale — container supplied for sale** | Approved Container Purchase/customer sale quote → CC record created → supplier commitment confirmed | `S{CC ID}` | One-time | Match container specification, price, delivery/acceptance and customer revenue to the same CC record. Example: CC `1234` → `S1234`. |
| **Empty container storage — Asset or For Hire CC record** | CC record created and storage requirement confirmed | Reference is entirely from the **CC record**; no deal attachment | Recurring as applicable | Reconcile storage location/period and prevent an unrelated Deal ID being used as the reference. |
| **Loaded customer container storage** | Storage requirement confirmed for customer-owned loaded container | Monthly PO referenced independently from the deal; no CC record exists for the customer-owned container | Monthly while stored | Maintain the approved independent reference and reconcile storage days to customer charges. |

> **Container Control numbering rule.** `A{CC ID}` is reserved for an asset purchased from a supplier, and `S{CC ID}` is reserved for the one-time cost associated with a customer sale. The for-hire and storage processes are recurring and must use the approved Container Control/Finance reference rather than an invented deal-based number.

## 6. Container hire procedure

Container Hire is a quote-to-Container-Control-to-recurring-PO process.

| Step | Owner | Procedure |
|---|---|---|
| **1. Quote request** | AR / Sales / Operations | Use the quote-request title: `{Deal ID} {Container Type} hire {Empty Container Origin} and dehire {Empty Container Destination}`. Example: `D702118 20GP hire Melbourne and dehire Brisbane`. |
| **2. Commercial approval** | AR / Sales / Management | Confirm customer rate, supplier hire rate, start event, dehire point, minimum term, recurring billing frequency, included charges and treatment of damage/detention. |
| **3. Container Control record** | Operations | Generate/link the CC record from the approved Container Hire template. The CC record is the required point of control before a hire PO is created. |
| **4. Monthly supplier PO** | Finance/AP / Operations | Create the recurring monthly **For Hire** PO against the CC record, using the approved Finance reference. Do not use an unconfigured `CH{Deal ID}` number. |
| **5. Customer revenue** | AR | Start customer hire billing only from the approved start trigger. Link every recurring invoice to the Deal ID and CC record. |
| **6. Dehire close-out** | Operations / AR / Finance | Confirm dehire date/location, stop customer recurring charges, process the final supplier hire cost and reconcile days, credits, detention and damages before closing the CC record. |

## 7. Container purchase procedure

Container Purchase is an asset/customer-sale controlled workflow. It must use the CC record as the source of truth for container specifications and reference.

| Step | Owner | Procedure |
|---|---|---|
| **1. Quote request** | AR / Sales / Operations | Use the quote-request title: `{Deal ID} {Container Type} {Container Grade} for Purchase In {Origin Suburb}`. Example: `D702118 20GP A Grade for Purchase In Melbourne`. |
| **2. Commercial and specification approval** | AR / Sales / Management | Confirm customer sale terms, supplier price, container type, grade, container/serial number where available, delivery location, title/ownership treatment, warranty and acceptance evidence. |
| **3. Container Control record** | Operations | Create/link the CC record from the approved Container Purchase template. Record the Deal ID, container specification and supplier commitment. |
| **4. Supplier asset PO** | Finance/AP | Raise the one-time supplier asset PO as `A{CC ID}` after the CC record and supplier quotation are approved. Attach source quotation/evidence and use the approved Xero asset/purchase account category. |
| **5. Customer-sale cost control** | Finance/AP / AR | Where the container is sold to a customer, use `S{CC ID}` for the one-time customer-sale cost reference. |
| **6. Customer invoice and close-out** | AR / Operations | Create the customer `ACCREC` invoice only when the contracted billing trigger is satisfied; reconcile delivery/acceptance, supplier bill, final margin and ownership evidence to the Deal ID and CC record. |

## 8. Exceptions and escalation

| Scenario | Mandatory action |
|---|---|
| A mapped Vtiger cost is blank or zero | No Stage 1 operational PO is expected. Operations must correct/approve the source cost if a supplier commitment exists. |
| Expected PO number already exists | Treat as duplicate protection. Review the existing PO and its Deal ID/CC record; never create a variation by changing the number. |
| Supplier invoice differs from PO | AP queries the supplier and Operations. AR must not absorb an unapproved supplier variance through a customer invoice, credit or write-off. |
| PO is already Billed | Do not reuse it; escalate immediately for duplicate-billing review. |
| New carrier, cost type or container product | Obtain joint Operations and Finance approval for the source field, prefix, number rule, supplier contact, Xero account category and ownership. Update this SOP and system configuration together. |
| Unclear hire/storage reference | Use the CC record and approved Finance reference. Do not invent `CH`, `CP` or other deal-based PO prefixes. |

## 9. AR checklist

AR must complete the following checks before final customer billing or month-end close:

1. Confirm that the Vtiger Deal ID, Container Control record (where applicable), supplier PO and customer sales invoice refer to the same underlying job/container.
2. Confirm that all customer sales invoices are `ACCREC` and that supplier costs are not mistakenly represented as customer invoices.
3. Confirm that the relevant supplier PO is authorised before treating the cost as final in a margin review.
4. Confirm that a Billed PO is not being reused and that the related supplier bill is reconciled to the job.
5. For Container Hire, reconcile active hire days, start/dehire dates, monthly supplier cost and monthly customer revenue.
6. For Container Purchase/Customer Sale, reconcile specification, CC ID, supplier acquisition cost, delivery/acceptance evidence, customer invoice and final margin.
7. Escalate unconfigured prefixes, missing CC records, numbers with altered suffixes and any material revenue/cost variance before closing the job.

## References

[1]: https://developer.xero.com/documentation/api/accounting/invoices "Xero Developer — Accounting API invoices"
[2]: ./server/vtigerPoService.ts "AP Invoice Manager — Vtiger-to-Xero Purchase Order configuration (internal source)"
[3]: https://central.xero.com/s/article/Creating-bills-from-purchase-orders "Xero Central — Create bills from purchase orders"
