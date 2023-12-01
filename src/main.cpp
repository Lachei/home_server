#include <iostream>
#include "crow/crow.h"

#include "Credentials.hpp"
#include "Database.hpp"
#include "database_util.hpp"

struct AccessControlHeader{
    struct context{};
    
    void before_handle(crow::request& req, crow::response& res, context& ctx){}
    void after_handle(crow::request& req, crow::response& res, context& ctx){
        // only add access control allow for login/main page
        if(req.url.find("18080") - req.url.size() <= 1) {
            res.add_header("Access-Control-Allow-Origin", "*");
            res.add_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.add_header("Access-Control-Allow-Headers", "Content-Type");
            res.add_header("Access-Control-Allow-Credentials", "true");
        }
    }
};

int main() {
    crow::App<AccessControlHeader> app;
    
    Credentials credentials("credentials/cred.json");
    Database event_database("data/events");
    database_util::setup_event_table(event_database);

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
    
    CROW_ROUTE(app, "/get_events")([&credentials, &event_database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto events = database_util::get_events(event_database, username);
        return events.dump();
    });
    CROW_ROUTE(app, "/get_event/<int>")([&credentials, &event_database](const crow::request& req, uint64_t event_id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        auto event = database_util::get_event(event_database, username, event_id);
        return event.dump();
    });
    CROW_ROUTE(app, "/add_event").methods("POST"_method)([&credentials, &event_database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);
        
        try{
            const auto& event = nlohmann::json::parse(req.body);
            const auto& creator = event["creator"].get<std::string>();
            if (creator != username && username != admin_name)
                return nlohmann::json{{"error", "can not create event for other users, only admin can do that"}}.dump();
                
            auto result = database_util::add_event(event_database, event);
            return result.dump();
        } catch(nlohmann::json::parse_error e){
            return nlohmann::json{{"error", e.what()}}.dump();
        }
        
        return std::string{};
    });
    CROW_ROUTE(app, "/update_event").methods("POST"_method)([&credentials, &event_database](const crow::request& req){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto& event = nlohmann::json::parse(req.body);
        const auto& creator = event["creator"].get<std::string>();
        if (creator != username && username != admin_name)
            return nlohmann::json{{"error", "can not update an event from another user, only admin can do that"}}.dump();
        
        auto result = database_util::update_event(event_database, event);
        return result.dump();
    });
    CROW_ROUTE(app, "/delete_event/<int>")([&credentials, &event_database](const crow::request& req, uint64_t id){
        EXTRACT_CHECK_CREDENTIALS(req, credentials);

        const auto result = database_util::delete_event(event_database, username, id);
        return result.dump();
    });
    
    const auto overview_page = crow::mustache::load("overview.html");
    CROW_ROUTE(app, "/overview")([&credentials, &main_page_text, &overview_page](const crow::request& req){
        EXTRACT_CREDENTIALS(req);
        
        if (!credentials.check_credential(std::string(username), sha)){
            CROW_LOG_INFO << "Credential check failed for username " << username << ':' << sha;
            return main_page_text;
        }

        bool is_admin = username == admin_name;
        using op = std::pair<std::string const, crow::json::wvalue>;
        crow::mustache::context crow_context{};
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
    const std::string user_css = crow::mustache::load_text("user.css");
    const std::string general_css = crow::mustache::load_text("general.css");
    const std::string sha_js = crow::mustache::load_text("sha256.js");
    const std::string tab_arbeitsplanung = crow::mustache::load_text("tabs/arbeitsplanung.html");
    const std::string tab_stempeluhr = crow::mustache::load_text("tabs/stempeluhr.html");
    const std::string tab_data = crow::mustache::load_text("tabs/data.html");
    const std::string tab_einstellungen = crow::mustache::load_text("tabs/einstellungen.html");
    CROW_ROUTE(app, "/admin.css")([&admin_css](){return admin_css;});
    CROW_ROUTE(app, "/user.css")([&user_css](){return user_css;});
    CROW_ROUTE(app, "/general.css")([&general_css](){return general_css;});
    CROW_ROUTE(app, "/sha256.js")([&sha_js](){return sha_js;});
    CROW_ROUTE(app, "/tabs/arbeitsplanung.html")([&tab_arbeitsplanung](){return tab_arbeitsplanung;});
    CROW_ROUTE(app, "/tabs/stempeluhr.html")([&tab_stempeluhr](){return tab_stempeluhr;});
    CROW_ROUTE(app, "/tabs/daten.html")([&tab_data](){return tab_data;});
    CROW_ROUTE(app, "/tabs/einstellungen.html")([&tab_einstellungen](){return tab_einstellungen;});

    app.port(18080).multithreaded().run();
    return 0;
}