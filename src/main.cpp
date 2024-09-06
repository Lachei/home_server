#include <iostream>
#include <regex>
#include "crow/crow.h"

#include "Credentials.hpp"
#include "Database.hpp"
#include "database_util.hpp"
#include "data_util.hpp"
#include "editor_util.hpp"

struct AccessControlHeader{
    struct context{};
    
    void before_handle(crow::request& req, crow::response& res, context& ctx){}
    void after_handle(crow::request& req, crow::response& res, context& ctx){
        // only add access control allow for login/main page
        if(req.url.size() == 1) {
            res.add_header("Access-Control-Allow-Origin", "*");
            res.add_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.add_header("Access-Control-Allow-Headers", "Content-Type");
            res.add_header("Access-Control-Allow-Credentials", "true");
        }
    }
};

void print_help()
{
    std::cout << "Home server can be called with the following command line arguments:\n";
    std::cout << "    ./home_server [OptionalArgs] --data data/path\n";
    std::cout << "RequiredArgs:\n";
    std::cout << "    --data    : The directory where the data tab stores all data files\n";
    std::cout << "    --cert    : The directory where the certificate files can be found\n";
    std::cout << "OptionalArgs:\n";
    std::cout << "    --help    : Prints this help dialogue\n";
}

std::string_view get_parameter(std::span<const char*> args, std::string_view parameter) {
    if (!std::ranges::contains(args, parameter))
        return {};
    
    auto e = std::ranges::find(args, parameter);
    if (e == args.end() || ++e == args.end())
        return {};
    
    return *e;
}

using namespace std::string_view_literals;
int main(int argc, const char** argv) {
    load_admin_credentials();
    std::span<const char*> args(argv, argc);
    bool show_help = std::ranges::contains(args, "--help"sv);
    
    std::string_view data_base_folder = get_parameter(args, "--data");
    if (data_base_folder.empty()) {
        std::cout << "[warning] Missing --data argument.\n";
        show_help = true;
        data_base_folder = "daten/";
    }

    std::string_view certificates_folder = get_parameter(args, "--cert");
    if (certificates_folder.empty()) {
        std::cout << "[warning] Missing --cert argument, defaulting to data/certificates/\n";
        show_help = true;
        certificates_folder = "data/certification/";
    }
 
    if (show_help)
        print_help();

    crow::App app;
    
    Credentials credentials("credentials/cred.json");
    Database database("data/events");
    database_util::setup_event_table(database);
    database_util::setup_shift_tables(database);
    data_util::setup_data(data_base_folder);
    
    std::mutex invoice_file_mutex{};

    // ------------------------------------------------------------------------------------------------
    // Login/authentication
    // ------------------------------------------------------------------------------------------------
    const std::string main_page_text = crow::mustache::load_text("main.html");
    CROW_ROUTE(app, "/")([&main_page_text](){
        return main_page_text;
    });
    
    CROW_ROUTE(app, "/get_salt/<string>")([&credentials](const std::string& user){
        return credentials.get_user_salt(user);
    });

    CROW_ROUTE(app, "/get_create_salt/<string>")([&credentials](const std::string& user){
        // TODO: should only be doable by the admin, maybe delete functionality
        return credentials.get_or_create_user_salt(user);
    });
    
    CROW_ROUTE(app, "/change_password/<string>")([&credentials](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto new_pwd = req.headers.find("new_pwd");
        if (new_pwd == req.headers.end() || !credentials.contains(user))
            return std::string("Missing new_pwd in header infos or user is not available");
        
        if(username != user && username != admin_name) {
            return std::string("Only admin can change password of other users");
        }
            
        bool success = credentials.set_credential(user, new_pwd->second);
        if (success)
            return std::string("success");
        else 
            return std::string("failed");
    });
    
    CROW_ROUTE(app, "/delete_user/<string>")([&credentials](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        bool success = credentials.delete_credential(user);
        if (success)
            return std::string("success");
        else
            return std::string("error");
    });

    CROW_ROUTE(app, "/get_all_users")([&credentials](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        nlohmann::json ret = credentials.get_user_list();
        return ret.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Event creation, editing, deletion, querying
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/get_events")([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto events = database_util::get_events(database, username);
        return events.dump();
    });
    CROW_ROUTE(app, "/get_event/<int>")([&credentials, &database](const crow::request& req, uint64_t event_id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto event = database_util::get_event(database, username, event_id);
        return event.dump();
    });
    CROW_ROUTE(app, "/add_event").methods("POST"_method)([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        try{
            const auto& event = nlohmann::json::parse(req.body);
            const auto& creator = event["creator"].get<std::string>();
            if (creator != username && username != admin_name)
                return nlohmann::json{{"error", "can not create event for other users, only admin can do that"}}.dump();
                
            auto result = database_util::add_event(database, event);
            return result.dump();
        } catch(nlohmann::json::parse_error e){
            return nlohmann::json{{"error", e.what()}}.dump();
        }
        
        return std::string{};
    });
    CROW_ROUTE(app, "/update_event").methods("POST"_method)([&credentials, &database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto event = nlohmann::json::parse(req.body);
        const auto& creator = event["creator"].get<std::string>();
        if (creator != username && username != admin_name)
            return nlohmann::json{{"error", "can not update an event from another user, only admin can do that"}}.dump();
        
        auto result = database_util::update_event(database, event);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_event/<int>")([&credentials, &database](const crow::request& req, uint64_t id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto result = database_util::delete_event(database, username, id);
        return result.dump();
    });

    // ------------------------------------------------------------------------------------------------
    // Shift editing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/start_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not begin shift for another user, only admin can do that"}}.dump();
        
        auto result = database_util::start_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/check_active_shift/<string>")([&credentials, &database](const crow::request& req, const std::string user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not check shift for another user, only admin can do that"}}.dump();
        
        auto result = database_util::check_active_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/end_shift/<string>")([&credentials, &database](const crow::request& req, const std::string& user){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (username != user && username != admin_name)
            return nlohmann::json{{"error", "can not end shift for another user, only admin can do that"}}.dump();
        
        const auto result = database_util::end_shift(database, user);
        return result.dump();
    });
    CROW_ROUTE(app, "/get_shifts")([&credentials, &database](const crow::request& req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto res = database_util::get_shifts_grouped(database);
        return res.dump();
    });
    CROW_ROUTE(app, "/get_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        const auto res = database_util::get_shift(database, shift_id);
        return res.dump();
    });
    CROW_ROUTE(app, "/update_shift").methods("POST"_method)([&credentials, &database](const crow::request& req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        const auto shift = nlohmann::json::parse(req.body);
        const auto& user = shift["user"].get<std::string>();
        if (user != username && username != admin_name)
            return nlohmann::json{{"error", "can not update a shift of another person, only admin can do that"}}.dump();

        auto result = database_util::update_shift(database, shift);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_shift/<int>")([&credentials, &database](const crow::request& req, uint64_t shift_id) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        auto result = database_util::delete_shift(database, username, shift_id);
        return result.dump();
    });
    CROW_ROUTE(app, "/add_shift").methods("POST"_method)([&credentials, &database](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        const auto shift = nlohmann::json::parse(req.body);
        if(shift["user"].get<std::string>() != username && username != admin_name)
            return nlohmann::json{{"error", "can not insert a shift of another user, only admin can do that"}}.dump();
            
        auto result = database_util::add_shift(database, shift);
        return result.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Data processing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/daten/")([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        return data_util::get_dir_infos(data_base_folder, "").dump();
    });
    CROW_ROUTE(app, "/daten/<path>")([&credentials, &data_base_folder](const crow::request &req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);
        
        // sanity check which avoids any .. in the path. This hinders users to get folders
        // outside of the data subfolder which would be a security violation
        if (path.find("..") != std::string::npos)
            return crow::response{"{error: \".. is not allowed in the path.\"}"};

        crow::response res;
        std::filesystem::path file_path = data_base_folder.data() + path;
        if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path)) {
            std::string ext = file_path.extension();
            if (editor_util::is_extension_editor(ext))
                res = editor_util::get_editor(false, req, path, data_base_folder);
            else
                res.set_static_file_info(file_path.string());
        }
        else
            res.body = data_util::get_dir_infos(data_base_folder, path).dump();

        return res;
    });
    CROW_ROUTE(app, "/upload_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::write_file(data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(req.body.data()), req.body.size()});
        return res.dump();
    });
    CROW_ROUTE(app, "/create_folder")([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header is missing in the request"}}.dump();
        const auto res = data_util::create_dir(data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/create_file")([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        const auto res = data_util::update_file(data_base_folder.data() + req.headers.find("path")->second);
        return res.dump();
    });
    CROW_ROUTE(app, "/update_file").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        const auto res = data_util::update_file(data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(req.body.data()), req.body.size()});
        return res.dump();
    });
    CROW_ROUTE(app, "/move_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto move_infos = nlohmann::json::parse(req.body);
        const auto res = data_util::move_files(data_base_folder, move_infos);
        return res.dump();
    });
    CROW_ROUTE(app, "/delete_daten").methods("POST"_method)([&credentials, &data_base_folder](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto delete_files = nlohmann::json::parse(req.body);
        const auto res = data_util::delete_files(data_base_folder, delete_files);
        return res.dump();
    });
    
    CROW_ROUTE(app, "/create_rech")([&credentials, &data_base_folder, &invoice_file_mutex](const crow::request &req) {
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        if (req.headers.find("path") == req.headers.end())
            return nlohmann::json{{"error", "The path header field is missing in the reqeust"}}.dump();
        
        // atomically increment the invoice cache id
        const std::string invoice_cache_path = std::string(data_base_folder) + "rechnungs_cache.json";
        nlohmann::json invoice_cache{};
        nlohmann::json invoice{};
        {
            std::scoped_lock lock(invoice_file_mutex);
            std::ifstream invoice_cache_file(invoice_cache_path);
            try {
                invoice_cache = nlohmann::json::parse(invoice_cache_file);
                if (!invoice_cache.contains("cur_id"))
                    invoice_cache["cur_id"] = int(1);
            } catch (...) {
                invoice_cache= nlohmann::json{{"cur_id", 0}};
            };
            invoice_cache["cur_id"] = invoice_cache["cur_id"].get<int>() + 1;
            invoice["id"] = invoice_cache["cur_id"].get<int>();
            std::ofstream invoice_cache_out(invoice_cache_path);
            invoice_cache_out << invoice_cache.dump();
        }
        const std::string file_data = invoice.dump();

        const auto res = data_util::update_file(data_base_folder.data() + req.headers.find("path")->second, {reinterpret_cast<const std::byte*>(file_data.data()), file_data.size()});
        return res.dump();
    });
    
    // ------------------------------------------------------------------------------------------------
    // Map loading (read only and currently does not need authentication)
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/heightmap/meta")([](const crow::request& req) {
        // the tiles are already string encoded for faster processing
        // on the website side)
        static nlohmann::json meta = [](){  // single instantiate on first call
            std::vector<std::string> tiles;
            for (const auto& dir_entry: std::filesystem::recursive_directory_iterator("data/tiles")) {
                if (dir_entry.is_regular_file() && dir_entry.path().extension() == ".png") {
                    // finding the 2 last / from the back
                    std::string_view string_view = dir_entry.path().c_str();
                    string_view = string_view.substr(0, string_view.find_last_of("."));
                    int slash_count = 0;
                    auto c = string_view.end() - 1;
                    for (; c >= string_view.begin(); --c) {
                        if (*c == '/') ++slash_count;
                        if (slash_count >= 3) break;
                    }
                    tiles.emplace_back(c + 1, string_view.end());
                }
            }
            return nlohmann::json{{"tiles", std::move(tiles)}};
        }();

        crow::response res{meta.dump()};
        return res;
    });
    CROW_ROUTE(app, "/heightmap/<path>")([](const crow::request& req, const std::string& tile) {
        std::string filepath = "data/tiles/" + tile + ".png";
        if (!std::filesystem::exists(filepath))
            return crow::response{404, "{error: \"The heightmap could not be found\"}"};

        crow::response res;
        res.set_static_file_info(filepath);
        return res;
    });

    // ------------------------------------------------------------------------------------------------
    // File editing
    // ------------------------------------------------------------------------------------------------
    CROW_ROUTE(app, "/edit_tbl/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);

        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_md/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);
        
        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_rech/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);
        
        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    CROW_ROUTE(app, "/edit_gpx/<path>")([&credentials, &data_base_folder](const crow::request& req, const std::string& path) {
        EXTRACT_CHECK_CREDENTIALS_T(req, credentials, crow::response);
        
        return editor_util::get_editor(true, req, path, data_base_folder);
    });
    
    // ------------------------------------------------------------------------------------------------
    // General page loading
    // ------------------------------------------------------------------------------------------------
    const auto overview_page = crow::mustache::load("overview.html");
    CROW_ROUTE(app, "/overview").methods("POST"_method, "GET"_method)([&credentials, &main_page_text, &overview_page](const crow::request& req){
        EXTRACT_CREDENTIALS(req);
        
        crow::response res;
        if (!credentials.check_credential(std::string(username), sha)){
            CROW_LOG_INFO << "Credential check failed for username " << username << ':' << sha;
            return main_page_text;
        }

        bool is_admin = username == admin_name;
        using op = std::pair<std::string const, crow::json::wvalue>;
        crow::mustache::context crow_context{};
        crow_context["user_credentials"] = std::string(username) + ":" + std::string(sha);
        if (is_admin) {
            crow_context["benutzername"] = "admin";
            crow_context["user_specific_css"] = "admin.css";
            return overview_page.render_string(crow_context);
        }
        else {
            crow_context["benutzername"] = std::string(username);
            crow_context["user_specific_css"] = "user.css";
            return overview_page.render_string(crow_context);
        }
    });
    
    const std::string admin_css = crow::mustache::load_text("admin.css");
    CROW_ROUTE(app, "/admin.css")([&admin_css](){return admin_css;});
    const std::string user_css = crow::mustache::load_text("user.css");
    CROW_ROUTE(app, "/user.css")([&user_css](){return user_css;});
    const std::string sha_js = crow::mustache::load_text("sha256.js");
    CROW_ROUTE(app, "/sha256.js")([&sha_js](){crow::response r(sha_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string drawdown_js = crow::mustache::load_text("drawdown.js");
    CROW_ROUTE(app, "/drawdown.js")([&drawdown_js](){crow::response r(drawdown_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string math_jax_js = crow::mustache::load_text("math_jax.js");
    CROW_ROUTE(app, "/math_jax.js")([&math_jax_js](){crow::response r(math_jax_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string ling_alg_js = crow::mustache::load_text("lin_alg.js");
    CROW_ROUTE(app, "/lin_alg.js")([&ling_alg_js](){crow::response r(ling_alg_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string virtual_texture_js = crow::mustache::load_text("virtual_texture.js");
    CROW_ROUTE(app, "/virtual_texture.js")([&virtual_texture_js](){crow::response r(virtual_texture_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string proj4_js = crow::mustache::load_text("proj4.js");
    CROW_ROUTE(app, "/pro4.js")([&proj4_js](){crow::response r(proj4_js); r.add_header("Content-Type", crow::mime_types.at("js")); return r;});
    const std::string tab_arbeitsplanung = crow::mustache::load_text("tabs/arbeitsplanung.html");
    CROW_ROUTE(app, "/tabs/arbeitsplanung.html")([&tab_arbeitsplanung](){return tab_arbeitsplanung;});
    const std::string tab_stempeluhr = crow::mustache::load_text("tabs/stempeluhr.html");
    CROW_ROUTE(app, "/tabs/stempeluhr.html")([&tab_stempeluhr](){return tab_stempeluhr;});
    const std::string tab_data = crow::mustache::load_text("tabs/data.html");
    CROW_ROUTE(app, "/tabs/daten.html")([&tab_data](){return tab_data;});
    const std::string tab_einstellungen = crow::mustache::load_text("tabs/einstellungen.html");
    CROW_ROUTE(app, "/tabs/einstellungen.html")([&tab_einstellungen](){return tab_einstellungen;});
    
    // checking the certificates folder
#ifdef CROW_ENABLE_SSL
    if (std::filesystem::exists(std::string(certificates_folder) + "/cert.pem") &&
        std::filesystem::exists(std::string(certificates_folder) + "/privkey.pem"))
        app.ssl_file(std::string(certificates_folder) + "/cert.pem",
                     std::string(certificates_folder) + "/privkey.pem");
    else if (std::filesystem::exists(std::string(certificates_folder) + "/rsa.key") &&
             std::filesystem::exists(std::string(certificates_folder) + "/rsa.cert"))
        app.ssl_file(std::string(certificates_folder) + "/rsa.cert", 
                     std::string(certificates_folder) + "/rsa.key");
    else if (std::filesystem::exists(std::string(certificates_folder) + "/rsa.pem"))
        app.ssl_file(std::string(certificates_folder) + "/rsa.pem");
    else {
        bool folder_exists = std::filesystem::exists(certificates_folder.data());
        std::cout << "[error] Could not find the certificates files in the given"
                     "certificates folder: " << certificates_folder << "\n";
        return -1;
    }
#endif
    
    if (admin_salt.empty() || admin_sha256.empty()){
        std::cout << "[error] Missing admin salt or credentials\n";
        return -1;
    }

    app.port(12345).multithreaded().run();
    return 0;
}